function normalizePhone(input) {
  if (!input) return { original: "", canonical: "" };
  const original = String(input).trim();
  let cleaned = original.replace(/[\s\-\.]/g, "");
  cleaned = cleaned.replace(/^\+/, "");
  if (cleaned.startsWith("213")) {
    cleaned = "0" + cleaned.slice(3);
  }
  if (cleaned.startsWith("0") && cleaned.length === 10) {
    return { original, canonical: cleaned };
  }
  return { original, canonical: cleaned };
}

module.exports = { normalizePhone };
