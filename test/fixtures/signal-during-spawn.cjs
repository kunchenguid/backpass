const childProcess = require("node:child_process");
const process = require("node:process");

const spawn = childProcess.spawn;
childProcess.spawn = function signalDuringSpawn(...args) {
  const child = spawn.apply(this, args);
  if (process.env.BACKPASS_TEST_SIGNAL_DURING_SPAWN === "1") {
    delete process.env.BACKPASS_TEST_SIGNAL_DURING_SPAWN;
    process.emit("SIGTERM");
  }
  return child;
};
