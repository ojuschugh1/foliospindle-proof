const compareStrings = (a, b) => {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
};

const compareMatches = (a, b) => compareStrings(a.path, b.path) || a.line - b.line || compareStrings(a.literal, b.literal);

/**
 * @param {{ path: string, text: string }[]} files
 * @param {string[]} literals
 * @returns {{ path: string, line: number, literal: string }[]}
 */
const findMatches = (files, literals) => {
  const matches = [];
  for (const { path, text } of files) {
    text.split("\n").forEach((content, index) => {
      for (const literal of literals) {
        if (content.indexOf(literal) !== -1) {
          matches.push({ path, line: index + 1, literal });
        }
      }
    });
  }
  return matches.sort(compareMatches);
};

export { findMatches };
