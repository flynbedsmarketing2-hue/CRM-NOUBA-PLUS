const { parse } = require("csv-parse/sync");

function parseCsv(buffer) {
  const text = buffer.toString("utf8");
  return parse(text, {
    columns: true,
    skip_empty_lines: true,
    trim: true
  });
}

module.exports = { parseCsv };
