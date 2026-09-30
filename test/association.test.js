import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { associate, globToRegExp, passesStrict } from "../src/discovery/association.js";
import { isWindowsPath, localPath, parseDriveMounts, wslEnvironment } from "../src/discovery/paths.js";
import { normalizeRemote } from "../src/repo.js";

/** A repo identity backed by one real directory, so tier-1/tier-3 liveness is genuine. */
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-assoc-"));
  const live = fs.realpathSync(dir);
  return {
    repo: {
      name: "demo",
      root: live,
      realRoot: live,
      worktrees: [live],
      remotes: ["github.com/acme/demo"],
    },
    live,
  };
}

test("normalizeRemote collapses ssh, https and .git spellings to one identity", () => {
  const expected = "github.com/acme/demo";
  assert.equal(normalizeRemote("git@github.com:acme/demo.git"), expected);
  assert.equal(normalizeRemote("https://github.com/acme/demo"), expected);
  assert.equal(normalizeRemote("https://user@github.com/acme/demo.git/"), expected);
  assert.equal(normalizeRemote("ssh://git@github.com/acme/demo.git"), expected);
  assert.equal(normalizeRemote(""), null);
});

test("tier 1: a cwd that is a worktree, or sits inside one, is deterministic", () => {
  const { repo, live } = makeRepo();

  const exact = associate({ cwd: live }, repo);
  assert.equal(exact.tier, 1);
  assert.equal(exact.confidence, "exact");

  const nested = associate({ cwd: path.join(live, "src", "deep") }, repo);
  assert.equal(nested.tier, 1);
  assert.equal(nested.confidence, "nested");
});

test("tier 2: a recorded remote associates a session whose worktree is long gone", () => {
  const { repo } = makeRepo();
  const result = associate(
    { cwd: "/vanished/worktree/somewhere", remotes: ["https://github.com/acme/demo.git"] },
    repo,
  );
  assert.equal(result.tier, 2);
  assert.equal(result.confidence, "remote");
});

test("tier 3: a dead path ending in the repo name is best-effort only", () => {
  const { repo } = makeRepo();
  const result = associate({ cwd: "/vanished/treehouse/7/demo" }, repo);
  assert.equal(result.tier, 3);
  assert.equal(result.confidence, "path");
});

test("tier 3 never fires for a live path that belongs to a different repo", () => {
  const { repo } = makeRepo();
  const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "demo-")));
  assert.equal(associate({ cwd: other }, repo), null);
});

test("a user worktree glob promotes a dead path to tier 3", () => {
  const { repo } = makeRepo();
  const cwd = "/vanished/.treehouse/demo-abc123/4/checkout";

  assert.equal(associate({ cwd }, repo), null);

  const globbed = associate({ cwd }, repo, { worktreeGlobs: ["/vanished/.treehouse/demo-*/*/*"] });
  assert.equal(globbed.tier, 3);
  assert.equal(globbed.confidence, "glob");
});

test("tier 1.5: a live sibling clone is deterministic, not a foreign live path", () => {
  const { repo } = makeRepo();
  const sibling = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "demo-sibling-")));
  repo.siblingWorktrees = [sibling];

  const exact = associate({ cwd: sibling }, repo);
  assert.equal(exact.tier, 1.5);
  assert.equal(exact.confidence, "sibling");

  const nested = associate({ cwd: path.join(sibling, "src") }, repo);
  assert.equal(nested.tier, 1.5);

  const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "demo-other-")));
  assert.equal(associate({ cwd: other }, repo), null);
});

/** Run `fn` with the process cwd inside `dir`, the way `backpass` runs from inside a checkout. */
function fromInside(dir, fn) {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(previous);
  }
}

const WINDOWS_CWDS = [
  "C:\\work\\demo",
  "C:/work/demo",
  "D:\\Projects\\foo",
  "\\\\server\\share\\demo",
  "//server/share/demo",
];

test(
  "a Windows cwd matches no path tier on a POSIX host that is not WSL, even from inside the clone",
  { skip: process.platform === "win32" && "Windows spells these paths natively" },
  () => {
    const { repo, live } = makeRepo();
    const notWsl = { wsl: null };
    fromInside(live, () => {
      for (const cwd of WINDOWS_CWDS) {
        assert.equal(associate({ cwd }, repo, notWsl), null, `${cwd} is no path on this machine`);
        assert.equal(
          associate({ cwd, gitRoot: cwd }, repo, notWsl),
          null,
          `${cwd} as a recorded root matches nothing either`,
        );
        assert.equal(
          associate({ cwd, remotes: [] }, repo, { ...notWsl, worktreeGlobs: ["**"] }),
          null,
          `${cwd} never reaches the best-effort tier`,
        );
      }
      const remote = associate({ cwd: "C:\\work\\demo", remotes: ["git@github.com:acme/demo.git"] }, repo, notWsl);
      assert.equal(remote.tier, 2, "a recorded remote still associates the session");
    });
  },
);

test(
  "under WSL a Windows path to this distro is the same place as its POSIX spelling",
  { skip: process.platform === "win32" && "Windows spells these paths natively" },
  () => {
    const { repo, live } = makeRepo();
    const wsl = { distro: "Ubuntu", drives: new Map() };
    const backslashed = live.replaceAll("/", "\\");
    for (const cwd of [
      `\\\\wsl.localhost\\Ubuntu${backslashed}`,
      `//wsl.localhost/Ubuntu${live}`,
      `\\\\wsl$\\ubuntu${live}`,
    ]) {
      assert.equal(associate({ cwd }, repo, { wsl })?.tier, 1, cwd);
      assert.equal(associate({ cwd: `${cwd}/src` }, repo, { wsl })?.confidence, "nested", cwd);
    }
    assert.equal(associate({ cwd: `\\\\wsl.localhost\\Debian${backslashed}` }, repo, { wsl }), null, "another distro");
    assert.equal(associate({ cwd: `\\\\server\\share${backslashed}` }, repo, { wsl }), null, "a network share");
  },
);

test("a Windows cwd from another machine reaches no tier over there either", () => {
  const { repo } = makeRepo();
  const facts = { "C:/work/demo": { exists: false, real: "C:/work/demo" } };
  assert.equal(associate({ cwd: "C:/work/demo" }, repo, { facts, host: "mac-home" }), null);
  const remote = associate({ cwd: "C:/work/demo", remotes: ["https://github.com/acme/demo"] }, repo, {
    facts,
    host: "mac-home",
  });
  assert.equal(remote.tier, 2);
});

test("localPath refuses a Windows path only where it names no place", () => {
  for (const cwd of WINDOWS_CWDS) {
    assert.equal(isWindowsPath(cwd), true, cwd);
    assert.equal(localPath(cwd, { platform: "linux", wsl: null }), null, cwd);
    assert.equal(localPath(cwd, { platform: "darwin" }), null, cwd);
    assert.equal(localPath(cwd, { platform: "win32" }), cwd, cwd);
  }
  for (const posix of ["/home/me/demo", "relative/demo", "/", "a:b/c"]) {
    assert.equal(isWindowsPath(posix), false, posix);
    assert.equal(localPath(posix, { platform: "linux", wsl: null }), posix, posix);
  }
  assert.equal(localPath("", { platform: "linux" }), null);
  assert.equal(localPath(null, { platform: "linux" }), null);
});

test("under WSL a drive path is read where /proc/mounts mounts that drive", () => {
  const drives = parseDriveMounts(
    [
      "10 1 0:10 / /usr/lib/wsl/drivers ro - 9p drivers ro,aname=drivers;fmask=222;dmask=222",
      "11 1 0:11 /Users/me /mnt/me rw - 9p C:\\134 rw,aname=drvfs;path=C:\\",
      "12 1 0:12 / /Docker/host rw - 9p C:\\134Program\\040Files\\134Docker rw,aname=drvfs",
      "13 1 0:11 / /mnt/c rw shared:1 - 9p C:\\134 rw,aname=drvfs;path=C:\\;uid=1000",
      "14 1 0:14 / /win/d\\040drive rw - 9p D:\\134 rw,aname=drvfs;path=D:\\;uid=1000",
      "15 1 0:15 / /mnt/e rw - drvfs E: rw,uid=1000,gid=1000",
      "16 1 8:32 / / rw - ext4 /dev/sdc rw,relatime",
    ].join("\n"),
  );
  assert.deepEqual(
    [...drives],
    [
      ["c", "/mnt/c"],
      ["d", "/win/d drive"],
      ["e", "/mnt/e"],
    ],
  );
  const wsl = { distro: "Ubuntu", drives };
  const read = (recorded) => localPath(recorded, { platform: "linux", wsl });
  assert.equal(read("C:\\Users\\me\\repo"), "/mnt/c/Users/me/repo");
  assert.equal(read("C:/Users/me/repo/"), "/mnt/c/Users/me/repo");
  assert.equal(read("c:\\"), "/mnt/c");
  assert.equal(read("D:\\work\\x.ts"), "/win/d drive/work/x.ts");
  assert.equal(read("E:/a/../b"), "/mnt/e/b");
  for (const recorded of ["C:\\..", "C:/../..", "C:/a/../../.."]) {
    assert.equal(read(recorded), "/mnt/c", recorded);
  }
  for (const recorded of ["C:\\..\\..\\home\\me\\repo", "C:/../../home/me/repo"]) {
    assert.equal(read(recorded), "/mnt/c/home/me/repo", recorded);
  }
  assert.equal(read("//wsl.localhost/Ubuntu/../../home/me/repo"), "/home/me/repo");
  assert.equal(read("F:\\unmounted"), null, "a drive WSL has not mounted names nothing here");
  assert.equal(read("\\\\wsl.localhost\\Ubuntu\\home\\me\\repo"), "/home/me/repo");
  assert.equal(read("//wsl.localhost/Ubuntu/home/me/repo"), "/home/me/repo");
  assert.equal(read("\\\\wsl$\\UBUNTU\\home\\me"), "/home/me", "distro names are case-insensitive");
  assert.equal(read("\\\\wsl.localhost\\Ubuntu"), "/");
  assert.equal(read("\\\\wsl.localhost\\Debian\\home\\me"), null, "another distro");
  assert.equal(read("\\\\fileserver\\share\\repo"), null, "a network share");
  assert.equal(
    localPath("\\\\wsl.localhost\\Ubuntu\\home\\me", { platform: "linux", wsl: { distro: null, drives } }),
    null,
    "without WSL_DISTRO_NAME no distro path can be placed",
  );
});

test(
  "subdirectory mounts alone never associate a Windows drive path",
  { skip: process.platform === "win32" && "Windows spells these paths natively" },
  () => {
    const { repo, live } = makeRepo();
    const target = live.replaceAll("\\", "\\134").replaceAll(" ", "\\040");
    for (const mount of [
      `11 1 0:11 / ${target} rw - 9p C:\\134Users\\134me rw,aname=drvfs`,
      `11 1 0:11 /Users/me ${target} rw - 9p C:\\134 rw,aname=drvfs`,
    ]) {
      const wsl = { distro: "Ubuntu", drives: parseDriveMounts(mount) };
      assert.equal(localPath("C:\\work\\repo", { platform: "linux", wsl }), null);
      assert.equal(associate({ cwd: "C:\\work\\repo" }, repo, { wsl }), null);
      assert.equal(associate({ gitRoot: "C:/work/repo" }, repo, { wsl }), null);
    }
  },
);

test(
  "unrelated drive-named mounts neither prove WSL nor map Windows drives",
  { skip: process.platform === "win32" && "Windows spells these paths natively" },
  () => {
    const { repo, live } = makeRepo();
    const target = live.replaceAll("\\", "\\134").replaceAll(" ", "\\040");
    for (const filesystem of ["fuse.rclone C: rw", "9p C:\\134 rw", "9p C: rw,aname=other"]) {
      const mountinfo = `10 1 0:10 / ${target} rw - ${filesystem}`;
      assert.deepEqual([...parseDriveMounts(mountinfo)], [], filesystem);
      for (const kernel of ["6.8.0-generic", "6.6.87.2-microsoft-standard-WSL2"]) {
        const wsl = wslEnvironment({ platform: "linux", kernel, env: { WSL_DISTRO_NAME: "Ubuntu" }, mountinfo });
        if (kernel === "6.8.0-generic") {
          assert.equal(wsl, null, filesystem);
          for (const cwd of [`//wsl.localhost/Ubuntu${live}`, `\\\\wsl$\\Ubuntu${live.replaceAll("/", "\\")}`]) {
            assert.equal(associate({ cwd }, repo, { wsl }), null, filesystem);
          }
        }
        for (const cwd of ["C:\\", "C:/"]) {
          assert.equal(localPath(cwd, { platform: "linux", wsl }), null, filesystem);
          assert.equal(associate({ cwd }, repo, { wsl }), null, filesystem);
          assert.equal(associate({ gitRoot: cwd }, repo, { wsl }), null, filesystem);
        }
      }
    }
  },
);

test("wslEnvironment recognizes WSL by its kernel or drive mounts, never by an inherited distro name", () => {
  const drive = "13 1 0:11 / /mnt/c rw shared:1 - 9p C:\\134 rw,aname=drvfs;path=C:\\;uid=1000";
  const cases = [
    { kernel: "6.8.0-generic", mountinfo: "", wsl: false },
    { kernel: "6.8.0-generic", mountinfo: "16 1 8:32 / / rw - ext4 /dev/sdc rw,relatime", wsl: false },
    { kernel: "6.12.9-custom", mountinfo: drive, wsl: true },
    { kernel: "4.4.0-19041-Microsoft", mountinfo: "", wsl: true },
    { kernel: "6.6.87.2-microsoft-standard-WSL2", mountinfo: "", wsl: true },
    { kernel: "6.6.87.2-microsoft-standard-WSL2", mountinfo: drive, wsl: true },
  ];
  /** @type {NodeJS.Platform[]} */
  const platforms = ["linux", "darwin", "win32"];
  for (const { kernel, mountinfo, wsl } of cases) {
    for (const platform of platforms) {
      for (const distro of ["Ubuntu", undefined]) {
        const label = `${platform} / ${kernel} / ${mountinfo === drive ? "C: mounted" : "no drive mounts"} / ${distro}`;
        const environment = wslEnvironment({ platform, env: { WSL_DISTRO_NAME: distro }, kernel, mountinfo });
        if (platform !== "linux" || !wsl) {
          assert.equal(environment, null, label);
          continue;
        }
        assert.equal(environment.distro, distro || null, label);
        assert.deepEqual([...environment.drives], mountinfo === drive ? [["c", "/mnt/c"]] : [], label);
        assert.equal(
          localPath("\\\\wsl.localhost\\Ubuntu\\home\\me", { platform, wsl: environment }),
          distro ? "/home/me" : null,
          label,
        );
      }
    }
  }
});

test("wslEnvironment defaults to this machine's kernel and mount table", { skip: process.platform !== "linux" }, () => {
  const env = { WSL_DISTRO_NAME: "Ubuntu" };
  const mountinfo = fs.readFileSync("/proc/self/mountinfo", "utf8");
  assert.deepEqual(wslEnvironment({ env }), wslEnvironment({ env, kernel: os.release(), mountinfo }));
});

test("--strict keeps only the deterministic tiers", () => {
  assert.equal(passesStrict({ tier: 1 }, true), true);
  assert.equal(passesStrict({ tier: 1.5 }, true), true);
  assert.equal(passesStrict({ tier: 2 }, true), true);
  assert.equal(passesStrict({ tier: 3 }, true), false);
  assert.equal(passesStrict({ tier: 3 }, false), true);
  assert.equal(passesStrict(null, false), false);
});

test("globToRegExp treats * as one segment and ** as many", () => {
  assert.ok(globToRegExp("/a/*/c").test("/a/b/c"));
  assert.ok(!globToRegExp("/a/*/c").test("/a/b/x/c"));
  assert.ok(globToRegExp("/a/**/c").test("/a/b/x/c"));
});
