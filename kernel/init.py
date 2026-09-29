#!/usr/local/bin/python3
"""PID 1 of a notebook's microVM.

The root disk is read-only. This mounts the kernel filesystems and tmpfs for
everything that must be written, lays a throwaway writable layer over the
read-only notebook disk, then runs the kernel agent on vsock. When the agent
exits the VM powers off, and Firecracker exits with it.
"""

import ctypes
import fcntl
import os
import socket
import struct
import subprocess
import sys


def sh(*argv):
    subprocess.run(argv, check=False, stdout=subprocess.DEVNULL, stderr=sys.stderr)


def loopback_up():
    """`ip link set lo up`, without iproute2 in the image."""
    SIOCGIFFLAGS, SIOCSIFFLAGS, IFF_UP = 0x8913, 0x8914, 0x1
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    ifr = struct.pack("16sH", b"lo", 0)
    flags = struct.unpack("16sH", fcntl.ioctl(s, SIOCGIFFLAGS, ifr))[1]
    fcntl.ioctl(s, SIOCSIFFLAGS, struct.pack("16sH", b"lo", flags | IFF_UP))
    s.close()


def power_off():
    os.sync()
    libc = ctypes.CDLL(None, use_errno=True)
    # reboot=k on the command line: a restart makes Firecracker exit
    libc.reboot(0x01234567)


def main():
    sh("mount", "-t", "proc", "proc", "/proc")
    sh("mount", "-t", "sysfs", "sys", "/sys")
    sh("mount", "-t", "tmpfs", "-o", "mode=1777,size=50%", "tmp", "/tmp")
    sh("mount", "-t", "tmpfs", "-o", "mode=0755,size=16m", "run", "/run")

    # /etc/hosts: the host hands over the names a sandbox may reach (no DNS inside)
    with open("/run/hosts", "w") as f:
        f.write("127.0.0.1 localhost\n")
    sh("mount", "--bind", "/run/hosts", "/etc/hosts")

    # the notebook's files: read-only below, a tmpfs on top that dies with the VM
    # (/tmp's, which has room for what cells write to output/; /run is 16 MB)
    os.makedirs("/tmp/.nb/upper", exist_ok=True)
    os.makedirs("/tmp/.nb/work", exist_ok=True)
    if os.path.exists("/dev/vdb"):
        sh("mount", "-o", "ro", "/dev/vdb", "/mnt/notebook-ro")
        sh("mount", "-t", "overlay", "overlay", "-o", "lowerdir=/mnt/notebook-ro,upperdir=/tmp/.nb/upper,workdir=/tmp/.nb/work", "/notebook")

    loopback_up()
    os.makedirs("/tmp/querier", exist_ok=True)
    os.makedirs("/tmp/mpl", exist_ok=True)
    env = {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "HOME": "/tmp",
        "MPLCONFIGDIR": "/tmp/mpl",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONUNBUFFERED": "1",
        "BASALT_BIN": "/usr/local/bin/basalt",
    }
    agent = subprocess.Popen(
        ["/usr/local/bin/python3", "/opt/querier/kernel.py", "--vsock", "5000", "--work", "/tmp/querier", "--cwd", "/notebook", "--sync-output"],
        env=env,
    )
    # PID 1 reaps every orphan until the agent itself is done
    while True:
        try:
            pid, _ = os.wait()
        except ChildProcessError:
            break
        if pid == agent.pid:
            break
    power_off()


if __name__ == "__main__":
    try:
        main()
    finally:
        power_off()
