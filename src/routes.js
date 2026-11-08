import { Router } from "express";
import { Group, Student, Rec } from "./models.js";

const r = Router();

// ---------- helpers ----------
const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);
const httpError = (status, message) => Object.assign(new Error(message), { status });
const isId = (v) => typeof v === "string" && /^[0-9a-f]{24}$/i.test(v);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const defined = (o = {}, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
const pick = (o = {}) => Object.fromEntries(["a", "hw", "cw"].filter((k) => k in o).map((k) => [k, o[k]]));
// Архивация/восстановление не должны менять «время изменения» (updatedAt)
const NO_TS = { timestamps: false };
const byDeleted = (a, b) => b.deletedAt - a.deletedAt;

function needId(id, what = "id") {
  if (!isId(id)) throw httpError(400, `Некорректный ${what}`);
}

async function activeGroup(id) {
  needId(id, "id группы");
  const g = await Group.findOne({ _id: id, deletedAt: null });
  if (!g) throw httpError(404, "Группа не найдена");
  return g;
}

// Повтор при гонке уникального индекса (два быстрых upsert подряд)
async function retryDup(fn) {
  try { return await fn(); } catch (e) { if (e.code === 11000) return fn(); throw e; }
}

// ---------- state ----------
r.get("/health", (_req, res) => res.json({ ok: true }));

r.get("/state", wrap(async (_req, res) => {
  const [allGroups, allStudents] = await Promise.all([
    Group.find().sort({ createdAt: 1 }),
    Student.find().sort({ createdAt: 1 }),
  ]);
  const groupById = new Map(allGroups.map((g) => [String(g._id), g]));

  const groups = allGroups.filter((g) => !g.deletedAt);
  const activeIds = new Set(groups.map((g) => String(g._id)));
  const students = allStudents.filter((s) => !s.deletedAt && activeIds.has(String(s.groupId)));
  const records = students.length ? await Rec.find({ studentId: { $in: students.map((s) => s._id) } }) : [];

  // Архив: группы целиком (со списком учеников, ушедших вместе с ними)…
  const archGroups = allGroups
    .filter((g) => g.deletedAt)
    .sort(byDeleted)
    .map((g) => ({
      ...g.toJSON(),
      students: allStudents.filter((s) => String(s.groupId) === String(g._id) && s.deletedBy === "group" && s.deletedAt).map((s) => s.toJSON()),
    }));

  // …и отдельно удалённые ученики (с названием группы)
  const archStudents = allStudents
    .filter((s) => s.deletedAt && !(s.deletedBy === "group" && groupById.get(String(s.groupId))?.deletedAt))
    .sort(byDeleted)
    .map((s) => {
      const g = groupById.get(String(s.groupId));
      return { ...s.toJSON(), groupName: g?.name ?? "—", groupArchived: Boolean(g?.deletedAt) };
    });

  res.json({
    groups, students, records,
    archive: { groups: archGroups, students: archStudents },
  });
}));

// ---------- groups ----------
r.post("/groups", wrap(async (req, res) => {
  const { name, days, start, color, timeStart, timeEnd } = req.body;
  res.status(201).json(await Group.create({ name, days, start, color, timeStart, timeEnd }));
}));

r.put("/groups/:id", wrap(async (req, res) => {
  const g = await activeGroup(req.params.id);
  const upd = defined(req.body, ["name", "days", "start", "color", "timeStart", "timeEnd"]);
  // update-валидаторы не видят соседние поля, поэтому порядок времени проверяем здесь
  const ts = upd.timeStart ?? g.timeStart, te = upd.timeEnd ?? g.timeEnd;
  if (ts && te && te <= ts) throw httpError(400, "Время окончания должно быть позже начала");
  const doc = await Group.findByIdAndUpdate(req.params.id, upd, { new: true, runValidators: true });
  res.json(doc);
}));

// «Удаление» группы = перенос в архив вместе со всеми её учениками
r.delete("/groups/:id", wrap(async (req, res) => {
  const g = await activeGroup(req.params.id);
  const now = new Date();
  const { modifiedCount } = await Student.updateMany(
    { groupId: g._id, deletedAt: null },
    { $set: { deletedAt: now, deletedBy: "group" } },
    NO_TS
  );
  await Group.updateOne({ _id: g._id }, { $set: { deletedAt: now } }, NO_TS);
  res.json({ archivedStudents: modifiedCount });
}));

// ---------- students ----------
r.post("/students", wrap(async (req, res) => {
  const { groupId, last, first, phone, parent, joined } = req.body;
  await activeGroup(groupId);
  res.status(201).json(await Student.create({ groupId, last, first, phone, parent, joined }));
}));

r.put("/students/:id", wrap(async (req, res) => {
  needId(req.params.id, "id ученика");
  const upd = defined(req.body, ["groupId", "last", "first", "phone", "parent", "joined"]);
  if (upd.groupId !== undefined) await activeGroup(upd.groupId);
  const doc = await Student.findOneAndUpdate({ _id: req.params.id, deletedAt: null }, upd, { new: true, runValidators: true });
  if (!doc) throw httpError(404, "Ученик не найден");
  res.json(doc);
}));

// «Удаление» ученика = перенос в архив (отметки и баллы сохраняются)
r.delete("/students/:id", wrap(async (req, res) => {
  needId(req.params.id, "id ученика");
  const doc = await Student.findOneAndUpdate(
    { _id: req.params.id, deletedAt: null },
    { $set: { deletedAt: new Date(), deletedBy: "student" } },
    { new: true, timestamps: false }
  );
  if (!doc) throw httpError(404, "Ученик не найден");
  res.json(doc);
}));

// ---------- records ----------
r.put("/records", wrap(async (req, res) => {
  const { studentId, date, patch } = req.body;
  needId(studentId, "id ученика");
  if (!DATE_RE.test(date || "")) throw httpError(400, "Некорректная дата");
  const set = pick(patch);
  if (!Object.keys(set).length) throw httpError(400, "Нечего сохранять");
  if (!(await Student.exists({ _id: studentId, deletedAt: null }))) throw httpError(404, "Ученик не найден");

  const doc = await retryDup(() =>
    Rec.findOneAndUpdate({ studentId, date }, { $set: set }, { upsert: true, new: true, runValidators: true })
  );
  res.json(doc);
}));

// «Все пришли» — массовая отметка
r.post("/records/bulk", wrap(async (req, res) => {
  const { studentIds = [], date, patch } = req.body;
  if (!Array.isArray(studentIds) || !studentIds.every(isId)) throw httpError(400, "Некорректный список учеников");
  if (!DATE_RE.test(date || "")) throw httpError(400, "Некорректная дата");
  const set = pick(patch);
  if (!Object.keys(set).length) throw httpError(400, "Нечего сохранять");

  const ids = (await Student.find({ _id: { $in: studentIds }, deletedAt: null }, "_id")).map((s) => s._id);
  if (ids.length) {
    await retryDup(() =>
      Rec.bulkWrite(ids.map((studentId) => ({
        updateOne: { filter: { studentId, date }, update: { $set: set }, upsert: true },
      })))
    );
  }
  res.json({ updated: ids.length });
}));

// ---------- archive ----------
async function archivedGroup(id) {
  needId(id, "id группы");
  const g = await Group.findOne({ _id: id, deletedAt: { $ne: null } });
  if (!g) throw httpError(404, "Группа не найдена в архиве");
  return g;
}

async function archivedStudent(id) {
  needId(id, "id ученика");
  const s = await Student.findOne({ _id: id, deletedAt: { $ne: null } });
  if (!s) throw httpError(404, "Ученик не найден в архиве");
  return s;
}

// Вернуть группу вместе с учениками, которые ушли в архив вместе с ней
r.post("/archive/groups/:id/restore", wrap(async (req, res) => {
  const g = await archivedGroup(req.params.id);
  await Group.updateOne({ _id: g._id }, { $set: { deletedAt: null } }, NO_TS);
  const { modifiedCount } = await Student.updateMany(
    { groupId: g._id, deletedBy: "group" },
    { $set: { deletedAt: null, deletedBy: null } },
    NO_TS
  );
  res.json({ restoredStudents: modifiedCount });
}));

// Вернуть одного ученика в его группу (группа не должна лежать в архиве)
r.post("/archive/students/:id/restore", wrap(async (req, res) => {
  const s = await archivedStudent(req.params.id);
  const g = await Group.findById(s.groupId);
  if (!g) throw httpError(409, "Группа этого ученика удалена навсегда");
  if (g.deletedAt) throw httpError(409, `Сначала восстановите группу «${g.name}»`);
  await Student.updateOne({ _id: s._id }, { $set: { deletedAt: null, deletedBy: null } }, NO_TS);
  res.json({ ok: true });
}));

// Удалить навсегда: группа + все её ученики + их отметки
r.delete("/archive/groups/:id", wrap(async (req, res) => {
  const g = await archivedGroup(req.params.id);
  const ids = (await Student.find({ groupId: g._id }, "_id")).map((s) => s._id);
  await Rec.deleteMany({ studentId: { $in: ids } });
  await Student.deleteMany({ groupId: g._id });
  await Group.deleteOne({ _id: g._id });
  res.status(204).end();
}));

r.delete("/archive/students/:id", wrap(async (req, res) => {
  const s = await archivedStudent(req.params.id);
  await Rec.deleteMany({ studentId: s._id });
  await Student.deleteOne({ _id: s._id });
  res.status(204).end();
}));

// Полная очистка архива
r.delete("/archive", wrap(async (_req, res) => {
  const gids = (await Group.find({ deletedAt: { $ne: null } }, "_id")).map((g) => g._id);
  const sids = (await Student.find({ $or: [{ deletedAt: { $ne: null } }, { groupId: { $in: gids } }] }, "_id")).map((s) => s._id);
  await Rec.deleteMany({ studentId: { $in: sids } });
  await Student.deleteMany({ _id: { $in: sids } });
  await Group.deleteMany({ _id: { $in: gids } });
  res.json({ groups: gids.length, students: sids.length });
}));

export default r;
