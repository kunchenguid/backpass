import { createControlPath, startSshMaster } from "../../src/discovery/remote/ssh.js";

const controlPath = createControlPath();
const result = await startSshMaster({ destination: "mac-home", controlPath });
if (result.code !== 0) process.exit(1);
process.stdout.write(`${JSON.stringify({ controlPath, pid: result.master.child.pid })}\n`);
setInterval(() => {}, 60_000);
