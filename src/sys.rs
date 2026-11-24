use crate::Result;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

#[derive(Debug, Clone, Copy)]
pub struct MemoryStats {
    pub working_set_kb: u64,
    pub private_kb: Option<u64>,
}

static SHUTDOWN_FLAG: OnceLock<&'static AtomicBool> = OnceLock::new();

pub fn register_shutdown_flag(flag: &'static AtomicBool) {
    let _ = SHUTDOWN_FLAG.set(flag);

    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::System::Console::SetConsoleCtrlHandler;
        extern "system" fn handler(_ctrl_type: u32) -> i32 {
            if let Some(f) = SHUTDOWN_FLAG.get() {
                f.store(true, Ordering::SeqCst);
            }
            1
        }
        SetConsoleCtrlHandler(Some(handler), 1);
    }

    #[cfg(unix)]
    unsafe {
        extern "C" {
            fn signal(sig: i32, handler: extern "C" fn(i32)) -> usize;
        }
        extern "C" fn handler(_sig: i32) {
            if let Some(f) = SHUTDOWN_FLAG.get() {
                f.store(true, Ordering::SeqCst);
            }
        }
        signal(2, handler); // SIGINT
        signal(15, handler); // SIGTERM
    }
}

#[cfg(windows)]
pub fn is_pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    const STILL_ACTIVE: u32 = 259;

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut exit_code: u32 = 0;
        let ok = GetExitCodeProcess(handle, &mut exit_code);
        CloseHandle(handle);
        ok != 0 && exit_code == STILL_ACTIVE
    }
}

#[cfg(unix)]
pub fn is_pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    unsafe { kill(pid as i32, 0) == 0 }
}

#[cfg(windows)]
pub fn is_ats_daemon_pid(pid: u32) -> bool {
    if !is_pid_alive(pid) {
        return false;
    }
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut buf = [0u16; 512];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut len);
        CloseHandle(handle);
        if ok == 0 || len == 0 {
            return false;
        }
        let path_str = String::from_utf16_lossy(&buf[..len as usize]);
        let name = Path::new(&path_str)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        name.starts_with("ats-theme")
    }
}

#[cfg(target_os = "linux")]
pub fn is_ats_daemon_pid(pid: u32) -> bool {
    if !is_pid_alive(pid) {
        return false;
    }
    std::fs::read_to_string(format!("/proc/{pid}/comm"))
        .map(|s| s.trim().to_ascii_lowercase().starts_with("ats-theme"))
        .unwrap_or(false)
}

#[cfg(target_os = "macos")]
pub fn is_ats_daemon_pid(pid: u32) -> bool {
    if !is_pid_alive(pid) {
        return false;
    }
    Command::new("ps")
        .args(["-o", "comm=", "-p", &pid.to_string()])
        .output()
        .ok()
        .map(|o| {
            let comm = String::from_utf8_lossy(&o.stdout);
            Path::new(comm.trim())
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_ascii_lowercase()
                .starts_with("ats-theme")
        })
        .unwrap_or(false)
}

#[cfg(windows)]
pub fn terminate_pid(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};

    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if handle.is_null() {
            return false;
        }
        let ok = TerminateProcess(handle, 0);
        CloseHandle(handle);
        ok != 0
    }
}

#[cfg(unix)]
pub fn terminate_pid(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    unsafe { kill(pid as i32, 15) == 0 }
}

#[cfg(windows)]
pub fn process_memory_stats(pid: u32) -> Option<MemoryStats> {
    use std::mem::{size_of, zeroed};
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::ProcessStatus::{
        K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ,
    };

    unsafe {
        let mut handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, 0, pid);
        if handle.is_null() {
            handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        }
        if handle.is_null() {
            return None;
        }
        let mut pmc: PROCESS_MEMORY_COUNTERS_EX = zeroed();
        pmc.cb = size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
        let ok = K32GetProcessMemoryInfo(
            handle,
            (&mut pmc as *mut PROCESS_MEMORY_COUNTERS_EX).cast::<PROCESS_MEMORY_COUNTERS>(),
            pmc.cb,
        );
        CloseHandle(handle);
        if ok == 0 {
            return None;
        }
        Some(MemoryStats {
            working_set_kb: (pmc.WorkingSetSize as u64) / 1024,
            private_kb: Some((pmc.PrivateUsage as u64) / 1024),
        })
    }
}

#[cfg(target_os = "linux")]
pub fn process_memory_stats(pid: u32) -> Option<MemoryStats> {
    let status = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
    for line in status.lines() {
        if let Some(rest) = line.strip_prefix("VmRSS:") {
            let kb: u64 = rest.split_whitespace().next()?.parse().ok()?;
            return Some(MemoryStats {
                working_set_kb: kb,
                private_kb: None,
            });
        }
    }
    None
}

#[cfg(target_os = "macos")]
pub fn process_memory_stats(pid: u32) -> Option<MemoryStats> {
    let out = Command::new("ps")
        .args(["-o", "rss=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    let kb: u64 = String::from_utf8_lossy(&out.stdout).trim().parse().ok()?;
    Some(MemoryStats {
        working_set_kb: kb,
        private_kb: None,
    })
}

/// Ask Windows to reclaim idle working-set pages immediately after transient payload injection.
#[cfg(windows)]
pub fn trim_working_set() {
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, SetProcessWorkingSetSize};
    unsafe {
        let _ = SetProcessWorkingSetSize(GetCurrentProcess(), usize::MAX, usize::MAX);
    }
}

#[cfg(not(windows))]
pub fn trim_working_set() {}

pub fn spawn_detached(exe: &Path, args: &[&str], workdir: &Path) -> Result<u32> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;

        let make_cmd = |flags: u32| {
            let mut cmd = Command::new(exe);
            cmd.args(args)
                .current_dir(workdir)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(flags);
            cmd
        };

        // Prefer breaking away from parent terminal/IDE Job Object so daemon survives shell exit.
        let base_flags = CREATE_NO_WINDOW | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;
        let child = make_cmd(base_flags | CREATE_BREAKAWAY_FROM_JOB)
            .spawn()
            .or_else(|_| make_cmd(base_flags).spawn())?;
        return Ok(child.id());
    }

    #[cfg(not(windows))]
    {
        let mut cmd = Command::new(exe);
        cmd.args(args)
            .current_dir(workdir)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let child = cmd.spawn()?;
        Ok(child.id())
    }
}
