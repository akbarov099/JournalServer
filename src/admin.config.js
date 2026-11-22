import "dotenv/config";

export const adminAccount = {
  phone: process.env.ADMIN_PHONE,
  password: process.env.ADMIN_PASSWORD,
};

//
// Укажите свой номер и пароль администратора, затем перезапустите сервер.
// export const adminAccount = {
//   phone: "+996222222072",
//   password: "admin072",
// };
