import fs from "node:fs";

const target = process.env.BACKPASS_TEST_REPLACE_ON_ROLLBACK;
const replacement = process.env.BACKPASS_TEST_REPLACEMENT_TEXT;
const renameSync = fs.renameSync;
const cpSync = fs.cpSync;
let replaced = false;

fs.renameSync = function replaceBeforeSkillRollback(source, destination) {
  if (
    !replaced &&
    target &&
    source === target &&
    pathLooksLikeSkillRollback(destination)
  ) {
    replaced = true;
    fs.unlinkSync(source);
    if (process.env.BACKPASS_TEST_REPLACEMENT_DIRECTORY === "1") {
      fs.mkdirSync(source);
      fs.writeFileSync(`${source}/marker.txt`, replacement ?? "concurrent replacement\n");
    } else {
      fs.writeFileSync(source, replacement ?? "concurrent replacement\n");
    }
  }
  return renameSync.call(this, source, destination);
};

fs.cpSync = function rejectUnsupportedDirectoryCopy(source, destination, options) {
  if (process.env.BACKPASS_TEST_REJECT_DIRECTORY_COPY === "1" && pathLooksLikeSkillRollback(source)) {
    throw Object.assign(new Error("recursive copy cannot preserve a Unix socket"), { code: "EINVAL" });
  }
  return cpSync.call(this, source, destination, options);
};

function pathLooksLikeSkillRollback(file) {
  return file.includes(".backpass-rollback-");
}
