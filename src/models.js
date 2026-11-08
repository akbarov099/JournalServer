import mongoose from "mongoose";

const { Schema, model } = mongoose;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^(\d{2}:\d{2})?$/;
const dateField = { type: String, required: true, match: [DATE_RE, "Дата должна быть в формате ГГГГ-ММ-ДД"] };

// В ответах API: _id -> id, ObjectId -> строка.
// createdAt / updatedAt / deletedAt остаются (Date -> ISO-строка при сериализации).
const opts = (extra = []) => ({
  versionKey: false,
  timestamps: true,
  toJSON: {
    transform: (_doc, r) => {
      r.id = String(r._id);
      delete r._id;
      for (const k of ["groupId", "studentId"]) if (r[k]) r[k] = String(r[k]);
      for (const k of extra) delete r[k];
    },
  },
});

export const COLOR_KEYS = ["gold", "crimson", "lightblue", "silver", "emerald", "violet"];

// deletedAt != null  ->  группа лежит в архиве
export const Group = model("Group", new Schema({
  name: { type: String, required: [true, "Укажите название группы"], trim: true, maxlength: 80 },
  days: {
    type: [Number],
    validate: {
      validator: (v) => v.length > 0 && v.every((d) => Number.isInteger(d) && d >= 0 && d <= 6),
      message: "Выберите хотя бы один день недели",
    },
  },
  start: dateField, // YYYY-MM-DD
  timeStart: { type: String, default: "", match: [TIME_RE, "Время начала должно быть в формате ЧЧ:ММ"] }, // HH:MM
  timeEnd: {
    type: String, default: "", match: [TIME_RE, "Время окончания должно быть в формате ЧЧ:ММ"],
    validate: {
      validator(v) { return !v || !this.timeStart || v > this.timeStart; },
      message: "Время окончания должно быть позже начала",
    },
  },
  color: { type: String, enum: COLOR_KEYS, default: "lightblue" },
  deletedAt: { type: Date, default: null },
}, opts()));

// deletedAt != null  ->  ученик в архиве
// deletedBy: "student" — удалён сам по себе, "group" — ушёл в архив вместе с группой
export const Student = model("Student", new Schema({
  groupId: { type: Schema.Types.ObjectId, ref: "Group", required: true, index: true },
  last: { type: String, required: [true, "Укажите фамилию"], trim: true, maxlength: 60 },
  first: { type: String, required: [true, "Укажите имя"], trim: true, maxlength: 60 },
  phone: { type: String, default: "", trim: true, maxlength: 40 },
  parent: { type: String, default: "", trim: true, maxlength: 40 },
  joined: dateField, // YYYY-MM-DD
  deletedAt: { type: Date, default: null },
  deletedBy: { type: String, enum: ["student", "group"], default: null },
}, opts()));

// Одна запись = один ученик на один урок: посещаемость + баллы за ДЗ и классную работу
const recSchema = new Schema({
  studentId: { type: Schema.Types.ObjectId, ref: "Student", required: true },
  date: dateField,
  a: { type: String, enum: ["p", "a"], default: null },
  hw: { type: Number, min: 0, max: 4, default: null },
  cw: { type: Number, min: 0, max: 4, default: null },
}, opts(["createdAt", "updatedAt"]));
recSchema.index({ studentId: 1, date: 1 }, { unique: true });

export const Rec = model("Record", recSchema);
