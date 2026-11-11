// Windows'un kendi fonksiyonlarıyla kayıt defteri ve kısayol işlemleri
// (gizli reg.exe / PowerShell çalıştırmak yerine; antivirüsler bunu şüpheli buluyor).
package main

import (
	"runtime"
	"syscall"
	"unsafe"
)

var (
	advapi32 = syscall.NewLazyDLL("advapi32.dll")
	ole32    = syscall.NewLazyDLL("ole32.dll")

	pRegCreateKeyExW = advapi32.NewProc("RegCreateKeyExW")
	pRegOpenKeyExW   = advapi32.NewProc("RegOpenKeyExW")
	pRegSetValueExW  = advapi32.NewProc("RegSetValueExW")
	pRegDeleteValueW = advapi32.NewProc("RegDeleteValueW")
	pRegDeleteTreeW  = advapi32.NewProc("RegDeleteTreeW")
	pRegCloseKey     = advapi32.NewProc("RegCloseKey")

	pCoInitializeEx   = ole32.NewProc("CoInitializeEx")
	pCoUninitialize   = ole32.NewProc("CoUninitialize")
	pCoCreateInstance = ole32.NewProc("CoCreateInstance")
)

const (
	hkeyCurrentUser = 0x80000001
	keyAllAccess    = 0xF003F
	regSZ           = 1
	regDWORD        = 4
)

const uninstSubKey = `Software\Microsoft\Windows\CurrentVersion\Uninstall\Nabiz`
const runSubKey = `Software\Microsoft\Windows\CurrentVersion\Run`



func regOpenCreate(sub string) (uintptr, bool) {
	var h uintptr
	r, _, _ := pRegCreateKeyExW.Call(hkeyCurrentUser, uintptr(unsafe.Pointer(u16(sub))), 0, 0, 0, keyAllAccess, 0, uintptr(unsafe.Pointer(&h)), 0)
	return h, r == 0
}

func regSetString(sub, name, val string) {
	h, ok := regOpenCreate(sub)
	if !ok {
		return
	}
	defer pRegCloseKey.Call(h)
	b, _ := syscall.UTF16FromString(val)
	pRegSetValueExW.Call(h, uintptr(unsafe.Pointer(u16(name))), 0, regSZ, uintptr(unsafe.Pointer(&b[0])), uintptr(len(b)*2))
}

func regSetDword(sub, name string, val uint32) {
	h, ok := regOpenCreate(sub)
	if !ok {
		return
	}
	defer pRegCloseKey.Call(h)
	pRegSetValueExW.Call(h, uintptr(unsafe.Pointer(u16(name))), 0, regDWORD, uintptr(unsafe.Pointer(&val)), 4)
}

func regDeleteTree(sub string) {
	pRegDeleteTreeW.Call(hkeyCurrentUser, uintptr(unsafe.Pointer(u16(sub))))
	// ağaç silindikten sonra boş anahtarın kendisi
	advapi32.NewProc("RegDeleteKeyW").Call(hkeyCurrentUser, uintptr(unsafe.Pointer(u16(sub))))
}

func regDeleteValue(sub, name string) {
	var h uintptr
	if r, _, _ := pRegOpenKeyExW.Call(hkeyCurrentUser, uintptr(unsafe.Pointer(u16(sub))), 0, keyAllAccess, uintptr(unsafe.Pointer(&h))); r != 0 {
		return
	}
	defer pRegCloseKey.Call(h)
	pRegDeleteValueW.Call(h, uintptr(unsafe.Pointer(u16(name))))
}

// ---- Kısayol (IShellLinkW + IPersistFile) ----
type guid struct {
	d1     uint32
	d2, d3 uint16
	d4     [8]byte
}

var (
	clsidShellLink  = guid{0x00021401, 0, 0, [8]byte{0xC0, 0, 0, 0, 0, 0, 0, 0x46}}
	iidIShellLinkW  = guid{0x000214F9, 0, 0, [8]byte{0xC0, 0, 0, 0, 0, 0, 0, 0x46}}
	iidIPersistFile = guid{0x0000010B, 0, 0, [8]byte{0xC0, 0, 0, 0, 0, 0, 0, 0x46}}
)

// vtable'daki n. fonksiyonu çağırır
func comCall(obj uintptr, n int, args ...uintptr) uintptr {
	vtbl := *(*uintptr)(unsafe.Pointer(obj))
	fn := *(*uintptr)(unsafe.Pointer(vtbl + uintptr(n)*unsafe.Sizeof(uintptr(0))))
	all := append([]uintptr{obj}, args...)
	r, _, _ := syscall.SyscallN(fn, all...)
	return r
}

func makeShortcut(lnk, target, icon string) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	hr, _, _ := pCoInitializeEx.Call(0, 2) // COINIT_APARTMENTTHREADED
	if hr == 0 || hr == 1 {                  // S_OK / S_FALSE
		defer pCoUninitialize.Call()
	}
	var sl uintptr
	if r, _, _ := pCoCreateInstance.Call(uintptr(unsafe.Pointer(&clsidShellLink)), 0, 1 /*CLSCTX_INPROC_SERVER*/, uintptr(unsafe.Pointer(&iidIShellLinkW)), uintptr(unsafe.Pointer(&sl))); r != 0 || sl == 0 {
		return
	}
	defer comCall(sl, 2) // Release
	comCall(sl, 20, uintptr(unsafe.Pointer(u16(target))))                    // SetPath
	comCall(sl, 9, uintptr(unsafe.Pointer(u16(dirOf(target)))))              // SetWorkingDirectory
	comCall(sl, 17, uintptr(unsafe.Pointer(u16(icon))), 0)                   // SetIconLocation
	comCall(sl, 7, uintptr(unsafe.Pointer(u16("Nabız Müzik"))))              // SetDescription
	var pf uintptr
	if comCall(sl, 0, uintptr(unsafe.Pointer(&iidIPersistFile)), uintptr(unsafe.Pointer(&pf))) != 0 || pf == 0 {
		return
	}
	defer comCall(pf, 2)
	comCall(pf, 6, uintptr(unsafe.Pointer(u16(lnk))), 1) // Save(path, TRUE)
}

func dirOf(p string) string {
	for i := len(p) - 1; i >= 0; i-- {
		if p[i] == '\\' || p[i] == '/' {
			return p[:i]
		}
	}
	return p
}
