declare module "exceljs/dist/exceljs.min.js" {
  import type * as ExcelJS from "exceljs";
  const content: typeof ExcelJS;
  export default content;
}
