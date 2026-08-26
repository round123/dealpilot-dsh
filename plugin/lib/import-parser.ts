import * as path from 'node:path';
import ExcelJS from 'exceljs';

export type ImportFormat = 'csv' | 'markdown' | 'text' | 'xlsx';
export type NormalizedTable = { columns: string[]; rows: Record<string, string>[]; warnings: string[]; parser: string; sheet?: string };

function scalar(value: any): string {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object' && 'result' in value) return scalar(value.result);
  return String(value);
}

export async function parseXlsx(buffer: Buffer, options: { sheet?: string; headerRow?: number } = {}): Promise<NormalizedTable> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as any);
  const sheets = workbook.worksheets.filter(sheet => sheet.rowCount > 0);
  if (!sheets.length) throw new Error('XLSX 不包含非空工作表');
  const selected = options.sheet ? workbook.getWorksheet(options.sheet) : sheets[0];
  if (!selected) throw new Error(`找不到工作表：${options.sheet}`);
  const headerRow = Math.max(1, options.headerRow || 1);
  const header = selected.getRow(headerRow).values as any[];
  const columns = header.slice(1).map((value, index) => scalar(value).trim() || `column_${index + 1}`);
  const warnings: string[] = [];
  if (columns.every(value => /^column_\d+$/.test(value))) warnings.push('未识别到表头，已使用默认列名');
  const rows: Record<string, string>[] = [];
  selected.eachRow((row, number) => {
    if (number <= headerRow) return;
    const values = row.values as any[];
    const record: Record<string, string> = {};
    let hasValue = false;
    columns.forEach((column, index) => { const value = scalar(values[index + 1]); record[column] = value; if (value.trim()) hasValue = true; });
    if (hasValue) rows.push(record);
  });
  return { columns, rows, warnings, parser: 'xlsx', sheet: selected.name };
}

export function inferFormat(name: string, explicit?: ImportFormat): ImportFormat {
  if (explicit) return explicit;
  const ext = path.extname(name).toLowerCase();
  if (ext === '.xlsx' || ext === '.xlsm') return 'xlsx';
  if (ext === '.csv') return 'csv';
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  return 'text';
}
