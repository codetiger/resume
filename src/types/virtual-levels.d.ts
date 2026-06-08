// The `virtual:levels` module is provided by the `resume-refs` Vite plugin
// (see vite.config.ts): it is levels.json with every JSONPath reference into
// resume.json already resolved. Shape matches the raw levels file; levels.ts
// narrows it to RawLevel[].
declare module 'virtual:levels' {
  const data: { levels: unknown[] };
  export default data;
}

// Obfuscated contact details from resume.json, provided by the same plugin.
// `phone` is an encoded string (e.g. "0x…"); the game decodes it at runtime.
declare module 'virtual:contact' {
  const data: { phone: string };
  export default data;
}
