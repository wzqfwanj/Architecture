#!/usr/bin/env python3
"""一条命令完成：跑测试 -> 提交 -> 推送 -> 打包上传 -> 重启 -> 冒烟自检。

用法（在仓库根目录或任意位置都能跑）：

    python tools/deploy.py                    # 跑快速测试 + 提交 + 推送 + 部署
    python tools/deploy.py -m "修复 xxx"       # 指定提交信息
    python tools/deploy.py --tests all        # 跑全部本地测试
    python tools/deploy.py --tests none       # 不跑测试，只部署
    python tools/deploy.py --no-push          # 只部署到 dev，不推 GitHub
    python tools/deploy.py --dry-run          # 只打印要做什么，不执行

约定：
    主机 dev（见 ~/.ssh/config），远端目录 /opt/architecture，服务 architecture.service，
    端口 8060，密码在远端 /etc/architecture.env。
"""
import argparse
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCAL_PORT = 8123
CDP_PORT = 9222
REMOTE = "dev"
REMOTE_APP = "/opt/architecture"
GIT_PROXY = "http://127.0.0.1:7897"   # 本机 mihomo，直连 github 不通

CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
]

# 快速测试只跑核心交互，全部测试包含平移/连线等
QUICK_TESTS = ["tests/interaction.mjs", "tests/ports.mjs", "tests/multi.mjs", "tests/style.mjs"]
ALL_TESTS = [
    "tests/interaction.mjs",
    "tests/ports.mjs",
    "tests/multi.mjs",
    "tests/style.mjs",
    "tests/pan.mjs",
    "tests/middle.mjs",
    "tests/touch_save.mjs",
]

step_no = 0


def say(msg):
    print(msg, flush=True)


def step(title):
    global step_no
    step_no += 1
    say(f"\n[{step_no}] {title}")


def run(cmd, cwd=None, check=True, capture=True, timeout=None):
    """跑一条命令，返回 (code, stdout+stderr)。"""
    proc = subprocess.run(
        cmd,
        cwd=cwd or REPO,
        shell=isinstance(cmd, str),
        capture_output=capture,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )
    out = ((proc.stdout or "") + (proc.stderr or "")).strip()
    if check and proc.returncode != 0:
        say(out)
        raise SystemExit(f"命令失败（{proc.returncode}）: {cmd if isinstance(cmd, str) else ' '.join(cmd)}")
    return proc.returncode, out


def port_open(host, port, timeout=0.4):
    with socket.socket() as s:
        s.settimeout(timeout)
        return s.connect_ex((host, port)) == 0


def wait_port(host, port, seconds=20):
    deadline = time.time() + seconds
    while time.time() < deadline:
        if port_open(host, port):
            return True
        time.sleep(0.25)
    return False


def find_chrome():
    for p in CHROME_CANDIDATES:
        if p and os.path.exists(p):
            return p
    return None


class Harness:
    """起本地 python 服务和带调试端口的无头 Chrome，供 e2e 测试使用。"""

    def __init__(self):
        self.procs = []
        self.tmp = None

    def __enter__(self):
        if not port_open("127.0.0.1", LOCAL_PORT):
            say(f"  起本地服务 :{LOCAL_PORT}")
            self.procs.append(subprocess.Popen(
                [sys.executable, "server.py", str(LOCAL_PORT)],
                cwd=REPO,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            ))
            if not wait_port("127.0.0.1", LOCAL_PORT):
                raise SystemExit("本地服务没起来")

        if not port_open("127.0.0.1", CDP_PORT):
            chrome = find_chrome()
            if not chrome:
                raise SystemExit("找不到 Chrome，无法跑 e2e 测试（用 --tests none 跳过）")
            self.tmp = tempfile.mkdtemp(prefix="arch-chrome-")
            say(f"  起无头 Chrome :{CDP_PORT}")
            self.procs.append(subprocess.Popen(
                [chrome, "--headless=new", f"--remote-debugging-port={CDP_PORT}",
                 f"--user-data-dir={self.tmp}", "--no-first-run",
                 "--no-default-browser-check", "--disable-gpu", "about:blank"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            ))
            if not wait_port("127.0.0.1", CDP_PORT, 25):
                raise SystemExit("无头 Chrome 没起来")
        time.sleep(1.0)
        return self

    def __exit__(self, *exc):
        for p in self.procs:
            try:
                if os.name == "nt":
                    subprocess.run(["taskkill", "/PID", str(p.pid), "/T", "/F"],
                                   capture_output=True)
                else:
                    p.terminate()
            except Exception:
                pass
        if self.tmp:
            shutil.rmtree(self.tmp, ignore_errors=True)
        return False


def run_tests(mode):
    if mode == "none":
        say("  跳过测试")
        return
    tests = ALL_TESTS if mode == "all" else QUICK_TESTS
    with Harness():
        for t in tests:
            path = os.path.join(REPO, t)
            if not os.path.exists(path):
                say(f"  {t} 不存在，跳过")
                continue
            code, out = run(["node", path], check=False, timeout=300)
            summary = [l for l in out.splitlines() if l.startswith("通过") or l.startswith("FAIL")]
            tail = summary[-1] if summary else out.splitlines()[-1] if out.splitlines() else ""
            say(f"  {t:28s} {'OK' if code == 0 else 'FAILED'}  {tail}")
            if code != 0:
                say(out)
                raise SystemExit(f"测试失败: {t}")


def git_commit(message):
    _, status = run(["git", "status", "--porcelain"])
    if not status:
        say("  没有改动，跳过提交")
        return False
    run(["git", "add", "-A"])
    run(["git", "-c", "user.name=wzqfwanj",
         "-c", "user.email=wzqfwanj@users.noreply.github.com",
         "commit", "-q", "-m", message])
    _, log = run(["git", "log", "--oneline", "-1"])
    say(f"  {log}")
    return True


def git_push():
    code, out = run(
        ["git", "-c", f"http.proxy={GIT_PROXY}", "-c", f"https.proxy={GIT_PROXY}",
         "push", "origin", "HEAD"],
        check=False,
    )
    # git 把进度写到 stderr，成功时也可能被当成失败，按关键字判断
    if "->" in out or "Everything up-to-date" in out:
        say("  已推送")
        return
    say(out)
    raise SystemExit("推送失败")


def ahead_of_remote():
    """本地是否领先 origin。不能只看有没有新提交：
    amend、rebase 之后工作区是干净的，但远端确实落后。
    依次尝试：当前分支的上游 -> origin/<当前分支> -> 都拿不到就算 0。"""
    proxy = ["-c", f"http.proxy={GIT_PROXY}", "-c", f"https.proxy={GIT_PROXY}"]
    run(["git"] + proxy + ["fetch", "origin"], check=False)

    _, branch = run(["git", "rev-parse", "--abbrev-ref", "HEAD"], check=False)
    branch = branch.strip() or "master"
    for ref in ("@{u}", f"origin/{branch}"):
        code, out = run(["git", "rev-list", "--count", f"{ref}..HEAD"], check=False)
        if code == 0:
            try:
                return int(out.strip() or 0)
            except ValueError:
                continue
    return 0


def deploy():
    tar = os.path.join(tempfile.gettempdir(), "arch-deploy.tar.gz")
    run(["git", "archive", "--format=tar.gz", "-o", tar, "HEAD"])
    script = os.path.join(REPO, "tools", "remote_deploy.sh")

    say(f"  上传部署包（{os.path.getsize(tar) // 1024} KB）")
    run(["scp", "-o", "BatchMode=yes", tar, f"{REMOTE}:/tmp/arch-deploy.tar.gz"])
    run(["scp", "-o", "BatchMode=yes", script, f"{REMOTE}:/tmp/remote_deploy.sh"])

    say("  远端部署 + 冒烟")
    code, out = run(["ssh", "-o", "BatchMode=yes", REMOTE, "bash /tmp/remote_deploy.sh"],
                    check=False, timeout=180)
    for line in out.splitlines():
        if line.startswith(("---", "  ", "REMOTE", "SMOKE")) or line.strip() in ("active", "inactive"):
            say(line)
    if "REMOTE_OK" not in out:
        say(out)
        raise SystemExit("远端冒烟失败")


def smoke_public():
    """从本机打一次线上地址，确认反向代理链路也通。"""
    pwd_file = os.path.join(os.path.dirname(REPO), "arch_password.txt")
    if not os.path.exists(pwd_file):
        say("  没有 arch_password.txt，跳过公网检查")
        return
    import base64
    with open(pwd_file, encoding="utf-8") as fh:
        pwd = fh.read().strip()
    auth = "Basic " + base64.b64encode(f"admin:{pwd}".encode()).decode()
    url = "https://wkeeli.cn/arch/"

    def get(with_auth):
        req = urllib.request.Request(url)
        if with_auth:
            req.add_header("Authorization", auth)
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return r.status
        except urllib.error.HTTPError as e:
            return e.code
        except Exception as e:
            return f"ERR {e}"

    ok = get(True)
    no = get(False)
    say(f"  带密码 -> {ok}   不带密码 -> {no}")
    if ok != 200 or no != 401:
        raise SystemExit("公网链路检查失败")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-m", "--message", default="", help="提交信息")
    ap.add_argument("--tests", choices=["quick", "all", "none"], default="quick")
    ap.add_argument("--no-push", action="store_true")
    ap.add_argument("--no-deploy", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    os.chdir(REPO)
    _, branch = run(["git", "rev-parse", "--abbrev-ref", "HEAD"])
    say(f"仓库 {REPO}（分支 {branch}）")

    if args.dry_run:
        say(f"将要执行：测试={args.tests} 提交={args.message or '(自动)'} "
            f"推送={not args.no_push} 部署={not args.no_deploy}")
        return

    step(f"跑测试（{args.tests}）")
    run_tests(args.tests)

    step("提交")
    changed = git_commit(args.message or "chore: 更新")

    if not args.no_push and not args.no_deploy:
        ahead = ahead_of_remote()
        if changed or ahead:
            step(f"推送到 GitHub（领先远端 {ahead} 个提交）")
            git_push()
        else:
            say("  远端已是最新，跳过推送")

    if not args.no_deploy:
        step("部署到 dev")
        deploy()

        step("公网链路")
        smoke_public()

    say("\n完成。")


if __name__ == "__main__":
    main()
