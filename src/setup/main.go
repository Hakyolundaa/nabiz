// Nabız Kurulumu (Nabiz-Setup.exe)
// Uygulama dosyalarını içinde taşır; motoru (castLabs Electron) indirir,
// kısayolları ve "Programlar ve Özellikler" kaydını oluşturur. /uninstall ile kaldırır.
package main

import (
	"archive/zip"
	"embed"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

//go:embed app
var appFS embed.FS

const (
	engineVer  = "44.9.3+wvcus"
	appName    = "Nabız"
	accent     = 0x5C3BFF // BGR: #ff3b5c
	bgColor    = 0x151111 // #111115
	trackColor = 0x332A2A
)

var (
	user32   = syscall.NewLazyDLL("user32.dll")
	gdi32    = syscall.NewLazyDLL("gdi32.dll")
	kernel32 = syscall.NewLazyDLL("kernel32.dll")
	dwmapi   = syscall.NewLazyDLL("dwmapi.dll")

	pMessageBoxW        = user32.NewProc("MessageBoxW")
	pRegisterClassExW   = user32.NewProc("RegisterClassExW")
	pCreateWindowExW    = user32.NewProc("CreateWindowExW")
	pDefWindowProcW     = user32.NewProc("DefWindowProcW")
	pGetMessageW        = user32.NewProc("GetMessageW")
	pTranslateMessage   = user32.NewProc("TranslateMessage")
	pDispatchMessageW   = user32.NewProc("DispatchMessageW")
	pPostQuitMessage    = user32.NewProc("PostQuitMessage")
	pPostMessageW       = user32.NewProc("PostMessageW")
	pShowWindow         = user32.NewProc("ShowWindow")
	pUpdateWindow       = user32.NewProc("UpdateWindow")
	pLoadCursorW        = user32.NewProc("LoadCursorW")
	pLoadIconW          = user32.NewProc("LoadIconW")
	pGetSystemMetrics   = user32.NewProc("GetSystemMetrics")
	pBeginPaint         = user32.NewProc("BeginPaint")
	pEndPaint           = user32.NewProc("EndPaint")
	pFillRect           = user32.NewProc("FillRect")
	pDrawTextW          = user32.NewProc("DrawTextW")
	pInvalidateRect     = user32.NewProc("InvalidateRect")
	pGetClientRect      = user32.NewProc("GetClientRect")
	pDestroyWindow      = user32.NewProc("DestroyWindow")
	pGetDpiForSystem    = user32.NewProc("GetDpiForSystem")
	pSetForegroundWin   = user32.NewProc("SetForegroundWindow")
	pCreateSolidBrush   = gdi32.NewProc("CreateSolidBrush")
	pDeleteObject       = gdi32.NewProc("DeleteObject")
	pCreateFontW        = gdi32.NewProc("CreateFontW")
	pSelectObject       = gdi32.NewProc("SelectObject")
	pSetTextColor       = gdi32.NewProc("SetTextColor")
	pSetBkMode          = gdi32.NewProc("SetBkMode")
	pCreateCompatibleDC = gdi32.NewProc("CreateCompatibleDC")
	pCreateCompatBmp    = gdi32.NewProc("CreateCompatibleBitmap")
	pBitBlt             = gdi32.NewProc("BitBlt")
	pDeleteDC           = gdi32.NewProc("DeleteDC")
	pRoundRect          = gdi32.NewProc("RoundRect")
	pGetStockObject     = gdi32.NewProc("GetStockObject")
	pGetModuleHandleW   = kernel32.NewProc("GetModuleHandleW")
	pBeginUpdateRes     = kernel32.NewProc("BeginUpdateResourceW")
	pUpdateRes          = kernel32.NewProc("UpdateResourceW")
	pEndUpdateRes       = kernel32.NewProc("EndUpdateResourceW")
	pDwmSetAttr         = dwmapi.NewProc("DwmSetWindowAttribute")
)

type rect struct{ L, T, R, B int32 }
type paintStruct struct {
	hdc         uintptr
	fErase      int32
	rcPaint     rect
	fRestore    int32
	fIncUpdate  int32
	rgbReserved [32]byte
}
type wndClassEx struct {
	cbSize        uint32
	style         uint32
	lpfnWndProc   uintptr
	cbClsExtra    int32
	cbWndExtra    int32
	hInstance     uintptr
	hIcon         uintptr
	hCursor       uintptr
	hbrBackground uintptr
	lpszMenuName  *uint16
	lpszClassName *uint16
	hIconSm       uintptr
}
type msg struct {
	hwnd    uintptr
	message uint32
	wParam  uintptr
	lParam  uintptr
	time    uint32
	pt      struct{ x, y int32 }
	priv    uint32
}

func u16(s string) *uint16 { p, _ := syscall.UTF16PtrFromString(s); return p }

const (
	MB_OK          = 0x0
	MB_YESNO       = 0x4
	MB_ICONINFO    = 0x40
	MB_ICONQUEST   = 0x20
	MB_ICONERR     = 0x10
	MB_ICONWARN    = 0x30
	MB_DEFBUTTON2  = 0x100
	MB_SETFORE     = 0x10000
	IDYES          = 6
	WM_DESTROY     = 0x2
	WM_PAINT       = 0xF
	WM_CLOSE       = 0x10
	WM_ERASEBKGND  = 0x14
	WM_APP         = 0x8000
	WM_APP_CLOSE   = 0x8001
	DT_LEFT        = 0x0
	DT_RIGHT       = 0x2
	DT_VCENTER     = 0x4
	DT_SINGLELINE  = 0x20
	DT_END_ELLIPS  = 0x8000
	DT_NOPREFIX    = 0x800
	WS_CAPTION     = 0x00C00000
	WS_SYSMENU     = 0x00080000
	WS_MINIMIZEBOX = 0x00020000
	WS_VISIBLE     = 0x10000000
)

func msgBox(text string, flags uintptr) int {
	r, _, _ := pMessageBoxW.Call(0, uintptr(unsafe.Pointer(u16(text))), uintptr(unsafe.Pointer(u16(appName))), flags|MB_SETFORE)
	return int(r)
}

// ---------------- Kurulum penceresi ----------------
var (
	mu       sync.Mutex
	stTitle  = "Nabız kuruluyor"
	stText   = "Hazırlanıyor…"
	stDetail = ""
	stProg   = 0.0
	hwndMain uintptr
	scale    = 1.0
	working  = true
	lastPost time.Time
)

func set(text string, prog float64, detail string) {
	mu.Lock()
	if text != "" {
		stText = text
	}
	if prog >= 0 {
		stProg = prog
	}
	stDetail = detail
	mu.Unlock()
	if hwndMain != 0 && time.Since(lastPost) > 40*time.Millisecond {
		lastPost = time.Now()
		pPostMessageW.Call(hwndMain, WM_APP, 0, 0)
	}
}
func refresh() {
	if hwndMain != 0 {
		pPostMessageW.Call(hwndMain, WM_APP, 0, 0)
	}
}

func px(v int) int32 { return int32(float64(v) * scale) }

func font(size int, weight int) uintptr {
	f, _, _ := pCreateFontW.Call(uintptr(-px(size)), 0, 0, 0, uintptr(weight), 0, 0, 0, 1, 0, 0, 5, 0, uintptr(unsafe.Pointer(u16("Segoe UI"))))
	return f
}

func drawText(hdc uintptr, s string, r rect, flags uintptr) {
	p, _ := syscall.UTF16FromString(s)
	pDrawTextW.Call(hdc, uintptr(unsafe.Pointer(&p[0])), uintptr(len(p)-1), uintptr(unsafe.Pointer(&r)), flags|DT_SINGLELINE|DT_NOPREFIX)
}

func fill(hdc uintptr, r rect, color uintptr) {
	b, _, _ := pCreateSolidBrush.Call(color)
	pFillRect.Call(hdc, uintptr(unsafe.Pointer(&r)), b)
	pDeleteObject.Call(b)
}

func roundFill(hdc uintptr, r rect, color uintptr, rad int32) {
	b, _, _ := pCreateSolidBrush.Call(color)
	nullPen, _, _ := pGetStockObject.Call(8) // NULL_PEN
	ob, _, _ := pSelectObject.Call(hdc, b)
	op, _, _ := pSelectObject.Call(hdc, nullPen)
	pRoundRect.Call(hdc, uintptr(r.L), uintptr(r.T), uintptr(r.R+1), uintptr(r.B+1), uintptr(rad), uintptr(rad))
	pSelectObject.Call(hdc, ob)
	pSelectObject.Call(hdc, op)
	pDeleteObject.Call(b)
}

var fTitle, fText, fSmall uintptr

func paint(hwnd uintptr) {
	var ps paintStruct
	hdcWin, _, _ := pBeginPaint.Call(hwnd, uintptr(unsafe.Pointer(&ps)))
	var cr rect
	pGetClientRect.Call(hwnd, uintptr(unsafe.Pointer(&cr)))
	w, h := cr.R, cr.B
	// çift tamponlu çizim (titreme olmasın)
	hdc, _, _ := pCreateCompatibleDC.Call(hdcWin)
	bmp, _, _ := pCreateCompatBmp.Call(hdcWin, uintptr(w), uintptr(h))
	oldBmp, _, _ := pSelectObject.Call(hdc, bmp)

	mu.Lock()
	title, text, detail, prog := stTitle, stText, stDetail, stProg
	mu.Unlock()

	fill(hdc, rect{0, 0, w, h}, bgColor)
	pSetBkMode.Call(hdc, 1)

	// küçük "ada" logosu
	lx, ly := px(28), px(26)
	roundFill(hdc, rect{lx, ly, lx + px(54), ly + px(22)}, 0x000000, px(22))
	for i, bh := range []int{6, 12, 8, 13} {
		x := lx + px(13+i*8)
		hh := px(bh)
		roundFill(hdc, rect{x, ly + px(11) - hh/2, x + px(3), ly + px(11) + hh/2}, accent, px(3))
	}

	pSelectObject.Call(hdc, fTitle)
	pSetTextColor.Call(hdc, 0xFFFFFF)
	drawText(hdc, title, rect{px(96), px(18), w - px(28), px(56)}, DT_LEFT|DT_VCENTER)

	pSelectObject.Call(hdc, fText)
	pSetTextColor.Call(hdc, 0xC8C8C8)
	drawText(hdc, text, rect{px(28), px(76), w - px(90), px(102)}, DT_LEFT|DT_VCENTER|DT_END_ELLIPS)
	pSetTextColor.Call(hdc, 0xFFFFFF)
	drawText(hdc, fmt.Sprintf("%%%d", int(prog*100+0.5)), rect{w - px(90), px(76), w - px(28), px(102)}, DT_RIGHT|DT_VCENTER)

	// ilerleme çubuğu
	bt := px(112)
	roundFill(hdc, rect{px(28), bt, w - px(28), bt + px(8)}, trackColor, px(8))
	fw := int32(float64(w-px(56)) * prog)
	if fw > px(8) {
		roundFill(hdc, rect{px(28), bt, px(28) + fw, bt + px(8)}, accent, px(8))
	}

	pSelectObject.Call(hdc, fSmall)
	pSetTextColor.Call(hdc, 0x8E8E99)
	drawText(hdc, detail, rect{px(28), px(128), w - px(28), px(150)}, DT_LEFT|DT_VCENTER|DT_END_ELLIPS)

	pBitBlt.Call(hdcWin, 0, 0, uintptr(w), uintptr(h), hdc, 0, 0, 0x00CC0020)
	pSelectObject.Call(hdc, oldBmp)
	pDeleteObject.Call(bmp)
	pDeleteDC.Call(hdc)
	pEndPaint.Call(hwnd, uintptr(unsafe.Pointer(&ps)))
}

func wndProc(hwnd, m, wp, lp uintptr) uintptr {
	switch m {
	case WM_ERASEBKGND:
		return 1
	case WM_PAINT:
		paint(hwnd)
		return 0
	case WM_APP:
		pInvalidateRect.Call(hwnd, 0, 0)
		return 0
	case WM_APP_CLOSE:
		pDestroyWindow.Call(hwnd)
		return 0
	case WM_CLOSE:
		if working {
			if msgBox("Kurulum iptal edilsin mi?", MB_YESNO|MB_ICONQUEST|MB_DEFBUTTON2) == IDYES {
				os.Exit(1)
			}
			return 0
		}
		pDestroyWindow.Call(hwnd)
		return 0
	case WM_DESTROY:
		pPostQuitMessage.Call(0)
		return 0
	}
	r, _, _ := pDefWindowProcW.Call(hwnd, m, wp, lp)
	return r
}

func runWindow(title string, work func()) {
	runtime.LockOSThread()
	if pGetDpiForSystem.Find() == nil {
		d, _, _ := pGetDpiForSystem.Call()
		if d > 0 {
			scale = float64(d) / 96.0
		}
	}
	fTitle, fText, fSmall = font(24, 700), font(15, 400), font(13, 400)
	hInst, _, _ := pGetModuleHandleW.Call(0)
	icon, _, _ := pLoadIconW.Call(hInst, 1)
	cursor, _, _ := pLoadCursorW.Call(0, 32512)
	wc := wndClassEx{
		lpfnWndProc: syscall.NewCallback(wndProc), hInstance: hInst, hIcon: icon, hIconSm: icon,
		hCursor: cursor, lpszClassName: u16("NabizSetup"),
	}
	wc.cbSize = uint32(unsafe.Sizeof(wc))
	pRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc)))

	W, H := int(px(500)), int(px(200))
	sw, _, _ := pGetSystemMetrics.Call(0)
	sh, _, _ := pGetSystemMetrics.Call(1)
	hwnd, _, _ := pCreateWindowExW.Call(0, uintptr(unsafe.Pointer(u16("NabizSetup"))), uintptr(unsafe.Pointer(u16(title))),
		WS_CAPTION|WS_SYSMENU|WS_MINIMIZEBOX,
		uintptr((int(sw)-W)/2), uintptr((int(sh)-H)/2), uintptr(W), uintptr(H), 0, 0, hInst, 0)
	hwndMain = hwnd
	if pDwmSetAttr.Find() == nil {
		dark := int32(1)
		pDwmSetAttr.Call(hwnd, 20, uintptr(unsafe.Pointer(&dark)), 4) // koyu başlık çubuğu
	}
	pShowWindow.Call(hwnd, 5)
	pUpdateWindow.Call(hwnd)
	pSetForegroundWin.Call(hwnd)

	go work()

	var m msg
	for {
		r, _, _ := pGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		if int32(r) <= 0 {
			break
		}
		pTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
		pDispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
	}
}

// ---------------- Yardımcılar ----------------
func hidden(name string, args ...string) error {
	c := exec.Command(name, args...)
	c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	return c.Run()
}

func exists(p string) bool { _, err := os.Stat(p); return err == nil }

func destDir() string { return filepath.Join(os.Getenv("LOCALAPPDATA"), "Nabiz") }

func fail(err error) {
	working = false
	msgBox("Kurulum tamamlanamadı:\n\n"+err.Error()+"\n\nİnternet bağlantını kontrol edip tekrar dene.", MB_OK|MB_ICONERR)
	os.Exit(1)
}

type progReader struct {
	r          io.Reader
	got, total int64
}

func (p *progReader) Read(b []byte) (int, error) {
	n, err := p.r.Read(b)
	p.got += int64(n)
	if p.total > 0 {
		set("", 0.05+0.70*float64(p.got)/float64(p.total), fmt.Sprintf("%d / %d MB", p.got>>20, p.total>>20))
	}
	return n, err
}

func download(url, to string) error {
	var lastErr error
	for attempt := 1; attempt <= 3; attempt++ {
		lastErr = func() error {
			resp, err := http.Get(url)
			if err != nil {
				return err
			}
			defer resp.Body.Close()
			if resp.StatusCode != 200 {
				return fmt.Errorf("sunucu %d döndürdü", resp.StatusCode)
			}
			f, err := os.Create(to)
			if err != nil {
				return err
			}
			defer f.Close()
			pr := &progReader{r: resp.Body, total: resp.ContentLength}
			if _, err := io.Copy(f, pr); err != nil {
				return err
			}
			if resp.ContentLength > 0 && pr.got != resp.ContentLength {
				return fmt.Errorf("indirme yarıda kesildi")
			}
			return nil
		}()
		if lastErr == nil {
			return nil
		}
		set(fmt.Sprintf("İndirme hatası, tekrar deneniyor (%d/3)…", attempt), -1, lastErr.Error())
		time.Sleep(2 * time.Second)
	}
	return lastErr
}

func unzip(src, dst string) error {
	zr, err := zip.OpenReader(src)
	if err != nil {
		return err
	}
	defer zr.Close()
	n := len(zr.File)
	for i, f := range zr.File {
		p := filepath.Join(dst, f.Name)
		if !strings.HasPrefix(p, filepath.Clean(dst)+string(os.PathSeparator)) {
			continue
		}
		if f.FileInfo().IsDir() {
			os.MkdirAll(p, 0755)
			continue
		}
		os.MkdirAll(filepath.Dir(p), 0755)
		rc, err := f.Open()
		if err != nil {
			return err
		}
		out, err := os.Create(p)
		if err != nil {
			rc.Close()
			return err
		}
		_, err = io.Copy(out, rc)
		out.Close()
		rc.Close()
		if err != nil {
			return err
		}
		if i%20 == 0 {
			set("", 0.75+0.15*float64(i)/float64(n), f.Name)
		}
	}
	return nil
}

// Nabiz.exe'nin simgesini Nabız simgesiyle değiştir (başarısız olursa önemli değil)
func patchIcon(exe string, ico []byte) {
	if len(ico) < 6 {
		return
	}
	n := int(binary.LittleEndian.Uint16(ico[4:]))
	h, _, _ := pBeginUpdateRes.Call(uintptr(unsafe.Pointer(u16(exe))), 0)
	if h == 0 {
		return
	}
	grp := make([]byte, 6+14*n)
	binary.LittleEndian.PutUint16(grp[2:], 1)
	binary.LittleEndian.PutUint16(grp[4:], uint16(n))
	for i := 0; i < n; i++ {
		e := ico[6+16*i:]
		size := binary.LittleEndian.Uint32(e[8:])
		off := binary.LittleEndian.Uint32(e[12:])
		data := ico[off : off+size]
		pUpdateRes.Call(h, 3, uintptr(i+1), 1033, uintptr(unsafe.Pointer(&data[0])), uintptr(size))
		g := grp[6+14*i:]
		copy(g[0:12], e[0:12])
		binary.LittleEndian.PutUint16(g[12:], uint16(i+1))
	}
	pUpdateRes.Call(h, 14, 1, 1033, uintptr(unsafe.Pointer(&grp[0])), uintptr(len(grp)))
	pEndUpdateRes.Call(h, 0)
}

func shortcutPaths() []string {
	home := os.Getenv("USERPROFILE")
	desk := filepath.Join(home, "Desktop")
	// OneDrive masaüstü yönlendirmesi
	if od := os.Getenv("OneDrive"); od != "" && exists(filepath.Join(od, "Desktop")) {
		desk = filepath.Join(od, "Desktop")
	}
	if od := os.Getenv("OneDrive"); od != "" && exists(filepath.Join(od, "Masaüstü")) {
		desk = filepath.Join(od, "Masaüstü")
	}
	start := filepath.Join(os.Getenv("APPDATA"), `Microsoft\Windows\Start Menu\Programs`)
	return []string{filepath.Join(desk, "Nabız.lnk"), filepath.Join(start, "Nabız.lnk")}
}

func appVersion() string {
	b, err := appFS.ReadFile("app/version.json")
	if err != nil {
		return "1.0.0"
	}
	s := string(b)
	i := strings.Index(s, `"version"`)
	if i < 0 {
		return "1.0.0"
	}
	s = s[i+9:]
	a := strings.Index(s, `"`)
	bq := strings.Index(s[a+1:], `"`)
	return s[a+1 : a+1+bq]
}

// ---------------- Kurulum ----------------
func install() {
	dest := destDir()
	exe := filepath.Join(dest, "Nabiz.exe")
	marker := filepath.Join(dest, "motor.txt")

	set("Açık Nabız kapatılıyor…", 0.02, "")
	hidden("taskkill", "/F", "/IM", "Nabiz.exe")
	time.Sleep(700 * time.Millisecond)

	have, _ := os.ReadFile(marker)
	if !exists(exe) || strings.TrimSpace(string(have)) != engineVer {
		os.RemoveAll(dest)
		if err := os.MkdirAll(dest, 0755); err != nil {
			fail(err)
		}
		arch := "x64"
		if os.Getenv("PROCESSOR_ARCHITECTURE") == "ARM64" || os.Getenv("PROCESSOR_ARCHITEW6432") == "ARM64" {
			arch = "arm64"
		}
		enc := strings.ReplaceAll(engineVer, "+", "%2B")
		url := fmt.Sprintf("https://github.com/castlabs/electron-releases/releases/download/v%s/electron-v%s-win32-%s.zip", enc, enc, arch)
		zipPath := filepath.Join(os.TempDir(), "nabiz-motor.zip")
		set("Uygulama motoru indiriliyor (sadece ilk kurulumda)…", 0.05, "")
		if err := download(url, zipPath); err != nil {
			fail(err)
		}
		set("Dosyalar çıkarılıyor…", 0.75, "")
		if err := unzip(zipPath, dest); err != nil {
			fail(err)
		}
		os.Remove(zipPath)
		if err := os.Rename(filepath.Join(dest, "electron.exe"), exe); err != nil {
			fail(err)
		}
		os.Remove(filepath.Join(dest, `resources\default_app.asar`))
		os.WriteFile(marker, []byte(engineVer), 0644)
	} else {
		set("Uygulama motoru zaten kurulu", 0.85, "")
	}

	set("Nabız dosyaları kopyalanıyor…", 0.9, "")
	appDir := filepath.Join(dest, `resources\app`)
	os.RemoveAll(appDir)
	err := fs.WalkDir(appFS, "app", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel := strings.TrimPrefix(p, "app")
		target := filepath.Join(appDir, filepath.FromSlash(rel))
		if d.IsDir() {
			return os.MkdirAll(target, 0755)
		}
		b, err := appFS.ReadFile(p)
		if err != nil {
			return err
		}
		return os.WriteFile(target, b, 0644)
	})
	if err != nil {
		fail(err)
	}

	set("Kısayollar oluşturuluyor…", 0.94, "")
	ico, _ := appFS.ReadFile("app/icon.ico")
	patchIcon(exe, ico)
	iconPath := filepath.Join(appDir, "icon.ico")
	for _, l := range shortcutPaths() {
		os.MkdirAll(filepath.Dir(l), 0755)
		makeShortcut(l, exe, iconPath)
	}

	// Kaldırıcı + Programlar ve Özellikler kaydı
	set("Son dokunuşlar…", 0.97, "")
	uninst := filepath.Join(dest, "Nabiz-Kaldir.exe")
	if self, err := os.Executable(); err == nil {
		if b, err := os.ReadFile(self); err == nil {
			os.WriteFile(uninst, b, 0755)
		}
	}
	regSetString(uninstSubKey, "DisplayName", appName)
	regSetString(uninstSubKey, "DisplayVersion", appVersion())
	regSetString(uninstSubKey, "Publisher", appName)
	regSetString(uninstSubKey, "DisplayIcon", iconPath)
	regSetString(uninstSubKey, "InstallLocation", dest)
	regSetString(uninstSubKey, "UninstallString", `"`+uninst+`" /uninstall`)
	regSetDword(uninstSubKey, "NoModify", 1)
	regSetDword(uninstSubKey, "NoRepair", 1)
	regSetDword(uninstSubKey, "EstimatedSize", 300000)

	mu.Lock()
	stTitle = "Nabız hazır!"
	mu.Unlock()
	set("Kurulum tamamlandı, Nabız açılıyor…", 1, "Masaüstündeki Nabız simgesiyle her zaman açabilirsin.")
	working = false
	c := exec.Command(exe)
	c.Dir = dest
	c.Start()
	time.Sleep(2200 * time.Millisecond)
	pPostMessageW.Call(hwndMain, WM_APP_CLOSE, 0, 0)
}

// ---------------- Kaldırma ----------------
func uninstall() {
	if msgBox("Nabız bilgisayarından kaldırılsın mı?", MB_YESNO|MB_ICONQUEST) != IDYES {
		return
	}
	keepData := msgBox("Kitaplığın, çalma listelerin ve ayarların da silinsin mi?\n\n\"Hayır\" dersen tekrar kurduğunda hepsi yerinde olur.", MB_YESNO|MB_ICONQUEST|MB_DEFBUTTON2) != IDYES
	hidden("taskkill", "/F", "/IM", "Nabiz.exe")
	time.Sleep(800 * time.Millisecond)
	for _, l := range shortcutPaths() {
		os.Remove(l)
	}
	regDeleteTree(uninstSubKey)
	regDeleteValue(runSubKey, "electron.app.Nabız")
	if !keepData {
		// yönetici paneli ayarları (bot anahtarı, kanal) veriler silinse de korunur
		keep := map[string]any{}
		for _, d := range []string{"Nabız", "nabiz"} {
			if b, err := os.ReadFile(filepath.Join(os.Getenv("APPDATA"), d, "ayarlar.json")); err == nil {
				var m map[string]any
				if json.Unmarshal(b, &m) == nil {
					for _, k := range []string{"adminToken", "adminChannel", "admin"} {
						if v, ok := m[k]; ok && v != nil && v != "" {
							keep[k] = v
						}
					}
				}
			}
		}
		os.RemoveAll(filepath.Join(os.Getenv("APPDATA"), "Nabız"))
		os.RemoveAll(filepath.Join(os.Getenv("APPDATA"), "nabiz"))
		if len(keep) > 0 {
			dir := filepath.Join(os.Getenv("APPDATA"), "Nabız")
			if os.MkdirAll(dir, 0755) == nil {
				if b, err := json.Marshal(keep); err == nil {
					os.WriteFile(filepath.Join(dir, "ayarlar.json"), b, 0644)
				}
			}
		}
	}
	dest := destDir()
	// Bu program klasörün içinden çalıştığı için silme işini kapandıktan sonra yaptır
	c := exec.Command("cmd", "/c", "ping -n 3 127.0.0.1 >nul & rmdir /s /q \""+dest+"\"")
	c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	c.Start()
	msgBox("Nabız kaldırıldı.", MB_OK|MB_ICONINFO)
}

func main() {
	for _, a := range os.Args[1:] {
		if strings.EqualFold(a, "/uninstall") || strings.EqualFold(a, "--uninstall") {
			uninstall()
			return
		}
	}
	// Kaldırıcı kopyası doğrudan açılırsa da kaldırma moduna geç
	if self, err := os.Executable(); err == nil && strings.EqualFold(filepath.Base(self), "Nabiz-Kaldir.exe") {
		uninstall()
		return
	}
	runWindow("Nabız Kurulumu", install)
}
