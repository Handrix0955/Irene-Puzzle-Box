// ======== localStorage 读写封装 ========
const unsavedStorage = new Map();

function storageGet(key, fallback) {
    try {
        const raw = unsavedStorage.has(key) ? unsavedStorage.get(key) : localStorage.getItem(key);
        if (raw == null) return fallback;
        try {
            return JSON.parse(raw);
        } catch (e) {
            return raw;
        }
    } catch (e) {
        return fallback;
    }
}

function storageSet(key, value) {
    try {
        const raw = typeof value === 'string' ? value : JSON.stringify(value);
        if (raw === undefined) return false;
        unsavedStorage.set(key, raw);
        localStorage.setItem(key, raw);
        unsavedStorage.delete(key);
        return true;
    } catch {
        return false;
    }
}

function normalizeStat(saved) {
    const best = Number.isFinite(saved?.best) && saved.best >= 0 ? saved.best : null;
    const avg = Number.isFinite(saved?.avg) && saved.avg >= 0 ? saved.avg : 0;
    const count = Number.isSafeInteger(saved?.count) && saved.count >= 0 ? saved.count : 0;
    return { best, avg, count };
}

function normalizeGameStats(saved, defaults) {
    return Object.fromEntries(Object.entries(defaults).map(([key, { name }]) => [
        key, { ...normalizeStat(saved?.[key]), name }
    ]));
}

const STAR_PROGRESS_KEYS = ['7', '8', '9', 'event_moon'];

function normalizeStarProgress(saved) {
    // v1 记录的是开局而非通关，保留此前的迁移语义。
    const source = saved?.ver === 2 ? saved : null;
    const played = {};
    const cycles = {};
    for (const key of STAR_PROGRESS_KEYS) {
        const entries = source?.played?.[key];
        played[key] = Array.isArray(entries) ? [...new Set(entries.filter(entry => typeof entry === 'string'))] : [];
        const count = source?.cycles?.[key];
        cycles[key] = Number.isSafeInteger(count) && count >= 0 ? count : 0;
    }
    return { ver: 2, played, cycles };
}

// ======== 战绩备份 ========
const SCORE_BACKUP_FORMAT = 'irene-puzzle-box';
const SCORE_BACKUP_FIELDS = {
    ireSudokuStats: ['35', '45', '55', 'event_total', 'event_qixi', 'event_moon', 'event'],
    ireStarStats: ['7', '8', '9', 'event_total', 'event_moon'],
    ireStarProgress: null
};

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function scoreBackupEntry(key, value) {
    if (!isRecord(value)) return null;
    if (key === 'ireStarProgress') {
        if (value.ver !== 2 || (!isRecord(value.played) && !isRecord(value.cycles))) return null;
        return normalizeStarProgress(value);
    }
    const stats = {};
    for (const mode of SCORE_BACKUP_FIELDS[key]) {
        const stat = value[mode];
        if (isRecord(stat) && Number.isSafeInteger(stat.count) && stat.count >= 0) {
            stats[mode] = normalizeStat(stat);
        }
    }
    return Object.keys(stats).length ? stats : null;
}

function createScoreBackup() {
    const data = {};
    for (const key of Object.keys(SCORE_BACKUP_FIELDS)) {
        const entry = scoreBackupEntry(key, storageGet(key, null));
        if (entry) data[key] = entry;
    }
    if (!Object.keys(data).length) throw new Error('目前没有可备份的战绩或进度。');
    const json = JSON.stringify({ format: SCORE_BACKUP_FORMAT, version: 1, data });
    let bytes = '';
    for (const byte of new TextEncoder().encode(json)) bytes += String.fromCharCode(byte);
    return btoa(bytes);
}

function decodeScoreBackup(code) {
    let backup;
    try {
        const json = code.startsWith('{') ? code : new TextDecoder('utf-8', { fatal: true }).decode(
            Uint8Array.from(atob(code.replace(/\s+/g, '')), byte => byte.charCodeAt(0))
        );
        backup = JSON.parse(json);
    } catch {
        throw new Error('无法读取备份码，请检查是否粘贴完整。');
    }
    if (backup?.format !== SCORE_BACKUP_FORMAT || backup.version !== 1 || !isRecord(backup.data)) {
        throw new Error('这不是受支持的 Puzzle Box 战绩备份。');
    }
    const updates = [];
    for (const key of Object.keys(SCORE_BACKUP_FIELDS)) {
        if (!Object.hasOwn(backup.data, key)) continue;
        const entry = scoreBackupEntry(key, backup.data[key]);
        if (!entry) throw new Error('备份中有无效的战绩或进度。');
        updates.push([key, JSON.stringify(entry)]);
    }
    if (!updates.length) throw new Error('备份中没有可恢复的战绩或进度。');
    return updates;
}

function restoreScoreBackup(code) {
    const updates = decodeScoreBackup(code.trim());
    const previous = new Map();
    const written = [];
    try {
        for (const [key] of updates) previous.set(key, localStorage.getItem(key));
        for (const [key, value] of updates) {
            localStorage.setItem(key, value);
            written.push([key, value]);
        }
    } catch {
        let rolledBack = true;
        for (const [key, value] of written.reverse()) {
            try {
                if (localStorage.getItem(key) !== value) continue;
                const saved = previous.get(key);
                if (saved === null) localStorage.removeItem(key);
                else localStorage.setItem(key, saved);
            } catch {
                rolledBack = false;
            }
        }
        throw new Error(rolledBack
            ? '无法保存备份，原有战绩已保留。请检查浏览器存储空间后重试。'
            : '恢复中断，部分数据可能已写入。请保留备份码后重试。');
    }
    for (const [key] of updates) unsavedStorage.delete(key);
}

function bindScoreBackup() {
    const dialog = document.getElementById('score-backup');
    const code = document.getElementById('score-backup-code');
    const status = document.getElementById('score-backup-status');
    document.getElementById('score-backup-open').addEventListener('click', () => {
        status.textContent = '';
        dialog.showModal();
    });
    document.getElementById('score-backup-close').addEventListener('click', () => dialog.close());
    document.getElementById('score-backup-copy').addEventListener('click', async () => {
        try {
            code.value = createScoreBackup();
        } catch (err) {
            status.textContent = err.message;
            return;
        }
        try {
            await navigator.clipboard.writeText(code.value);
            status.textContent = '备份码已复制。';
        } catch {
            code.focus();
            code.select();
            let copied = false;
            try { copied = document.execCommand('copy'); } catch {}
            status.textContent = copied ? '备份码已复制。' : '备份码已选中，请手动复制。';
        }
    });
    document.getElementById('score-backup-restore').addEventListener('click', () => {
        if (!code.value.trim()) {
            status.textContent = '请先粘贴备份码。';
            code.focus();
            return;
        }
        try {
            restoreScoreBackup(code.value);
        } catch (err) {
            status.textContent = err.message;
            return;
        }
        window.location.reload();
    });
}

function showAppMessage(title, body, color, iconSvg) {
    let overlay = document.getElementById('messageModal');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'messageModal';
        overlay.innerHTML = `
            <div class="modal-content" style="text-align: center;">
                <h2 id="msgTitle">提示</h2>
                <p id="msgBody" style="font-size: 15px; line-height: 1.5; margin: 20px 0; font-weight: 500;"></p>
                <button class="close-btn" id="msgCloseBtn" onclick="closeModal('messageModal')">知道啦！</button>
            </div>`;
        document.body.appendChild(overlay);
    }
    const msgTitle = document.getElementById('msgTitle');
    const msgBody = document.getElementById('msgBody');
    const closeBtn = document.getElementById('msgCloseBtn');
    if (msgTitle) {
        msgTitle.innerText = "";
        if (iconSvg) { const w = document.createElement("span"); w.className = "msg-icon"; w.innerHTML = iconSvg; msgTitle.appendChild(w); }
        msgTitle.appendChild(document.createTextNode(title));
        msgTitle.style.color = color || '';
    }
    if (msgBody) msgBody.innerText = body;
    if (closeBtn && color) closeBtn.style.background = color;
    overlay.style.display = 'flex';
}

// ======== 主题与皮肤 ========
const SKIN_KEY = 'ireSudokuSkin';
const THEME_KEY = 'ireTheme';
const SKINS = ['default', 'purple', 'pine'];
let currentTheme = 'dark';
let currentSkin = 'default';

// Lucide 图标: 灯泡 (黑夜模式显示, 点击开灯) / 月亮 (白天模式显示, 点击关灯)
const ICON_BULB = '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1.3.5 2.6 1.5 3.5.7.8 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>';
const ICON_MOON = '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>';

function applyThemeUI() {
    const dark = currentTheme === 'dark';
    document.body.setAttribute('data-skin', currentSkin);
    if (dark) document.body.setAttribute('data-theme', 'dark');
    else document.body.removeAttribute('data-theme');

    for (const id of ['theme-icon', 'theme-icon-game']) {
        const icon = document.getElementById(id);
        if (icon) icon.innerHTML = dark ? ICON_BULB : ICON_MOON;
    }
    const themeText = document.getElementById('theme-text');
    if (themeText) themeText.innerText = dark ? '开灯' : '关灯';
}

function syncPreferences(repaint = false) {
    const savedSkin = storageGet(SKIN_KEY, 'default');
    const skin = SKINS.includes(savedSkin) ? savedSkin : 'default';
    const theme = storageGet(THEME_KEY, 'dark') === 'light' ? 'light' : 'dark';
    const changed = skin !== currentSkin || theme !== currentTheme;
    currentSkin = skin;
    currentTheme = theme;
    applyThemeUI();
    if (repaint && changed) kickThemeRepaint();
}

function changeSkin(skin) {
    if (!SKINS.includes(skin)) return;
    storageSet(SKIN_KEY, skin);
    syncPreferences(true);
}

// iOS fix: theme toggle repaints huge background layers; Safari may keep stale tiles
// (a black bar at the bottom until navigation). Force one repaint of those layers.
function kickThemeRepaint() {
    document.body.classList.add("theme-kick");
    resizeCanvas(); // force canvas layers to rebuild (clears stale black tiles on iOS)
    requestAnimationFrame(() => {
        window.scrollBy(0, 1);
        requestAnimationFrame(() => window.scrollBy(0, -1));
        requestAnimationFrame(() => document.body.classList.remove("theme-kick"));
    });
}
function toggleTheme() {
    storageSet(THEME_KEY, currentTheme === 'dark' ? 'light' : 'dark');
    syncPreferences(true);
    if (currentTheme === 'dark') {
        showAppMessage('护眼模式', '是不是很晚了还在玩呀，早点休息噢宝宝，别玩太晚～', '#6366f1');
    }
}

// ======== 皮肤弹窗 (大厅/数独共用) ========
function openSkinModal() {
    const m = document.getElementById('skinModal');
    if (m) m.style.display = 'flex';
}

syncPreferences();
window.addEventListener('pageshow', () => syncPreferences(true));
window.addEventListener('storage', event => {
    if (event.key !== SKIN_KEY && event.key !== THEME_KEY && event.key !== null) return;
    for (const key of [SKIN_KEY, THEME_KEY]) {
        if (event.key === key || event.key === null) unsavedStorage.delete(key);
    }
    syncPreferences(true);
});

function closeModal(id) { document.getElementById(id).style.display = 'none'; }

function registerPuzzleWorker(scriptPath) {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register(scriptPath).catch(err => console.warn('SW register failed:', err));
}

// ======== 原生音效引擎 (无多余点击音效) ========
const AudioEngine = window.AudioContext || window.webkitAudioContext;
let audioCtx;
function initAudio() {
    try {
        if (!AudioEngine) return;
        if (!audioCtx || audioCtx.state === 'closed') audioCtx = new AudioEngine();
        if (audioCtx.state !== 'running') audioCtx.resume().catch(() => {});
    } catch {
        // 音效不可用时继续游戏。
    }
}

function playSound(type) {
    try {
        initAudio();
        if (!audioCtx || audioCtx.state !== 'running') return;
        const now = audioCtx.currentTime;
        if (type === 'bubble') {
            const osc = audioCtx.createOscillator(); const gain = audioCtx.createGain();
            osc.connect(gain); gain.connect(audioCtx.destination);
            osc.type = 'sine';
            osc.frequency.setValueAtTime(300, now); osc.frequency.exponentialRampToValueAtTime(900, now + 0.08);
            gain.gain.setValueAtTime(0, now); gain.gain.linearRampToValueAtTime(0.5, now + 0.01); gain.gain.exponentialRampToValueAtTime(0.01, now + 0.08);
            osc.start(now); osc.stop(now + 0.1);
        } else if (type === 'win') {
            const freqs = [523.25, 659.25, 783.99, 1046.50, 1318.51];
            freqs.forEach((freq, i) => {
                const o = audioCtx.createOscillator(); const g = audioCtx.createGain();
                o.connect(g); g.connect(audioCtx.destination); o.type = 'sine'; o.frequency.value = freq;
                g.gain.setValueAtTime(0, now + i*0.08); g.gain.linearRampToValueAtTime(0.2, now + i*0.08 + 0.02);
                g.gain.exponentialRampToValueAtTime(0.01, now + i*0.08 + 0.6);
                o.start(now + i*0.08); o.stop(now + i*0.08 + 0.7);
            });
        }
    } catch {
        // 音效失败不影响落子、提交或结算。
    }
}
document.body.addEventListener('touchstart', initAudio, {once:true}); document.body.addEventListener('click', initAudio, {once:true});

// ======== Canvas 引擎 (零发热宇宙星空 + 双向飞鸟爱心彩蛋) ========
const fxCanvas = document.getElementById('canvas-fx');
const fxCtx = fxCanvas ? fxCanvas.getContext('2d') : null;
const confCanvas = document.getElementById('canvas-confetti');
const confCtx = confCanvas ? confCanvas.getContext('2d') : null;
let bgParticles = []; let confParticles = []; let reqFx, reqConf;

let magpieTriggered = false; let magpies = []; let hearts = []; let magpiePhase = 0;

function resizeCanvas() {
    if (!fxCanvas || !confCanvas) return;
    // iOS fix: pin CSS size to the bitmap. 100vh is the LARGE viewport on iOS, so the
    // canvas element used to extend past its own bitmap, leaving an unpainted bottom
    // band that iOS renders as a black bar after compositing churn (theme toggle).
    const w = document.documentElement.clientWidth;
    const h = document.documentElement.clientHeight;
    [fxCanvas, confCanvas].forEach(function (cv) {
        cv.width = w; cv.height = h;
        cv.style.width = w + "px";
        cv.style.height = h + "px";
    });
}
window.addEventListener('resize', resizeCanvas); resizeCanvas();

function startEventBg() {
    if (!fxCanvas || !fxCtx) return;
    bgParticles = [];
    for(let i=0; i<60; i++) {
        bgParticles.push({
            x: Math.random() * fxCanvas.width, y: Math.random() * fxCanvas.height,
            radius: Math.random() * 1.5, alpha: Math.random(), speedAlpha: (Math.random() - 0.5) * 0.02, isShooting: false
        });
    }
    if(reqFx) cancelAnimationFrame(reqFx);
    function render() {
        fxCtx.clearRect(0, 0, fxCanvas.width, fxCanvas.height);

        if(Math.random() < 0.01) {
            bgParticles.push({
                x: Math.random() * fxCanvas.width, y: 0,
                len: Math.random() * 50 + 50, speed: Math.random() * 10 + 10,
                angle: Math.PI / 4, isShooting: true, alpha: 1
            });
        }

        for (let i = bgParticles.length - 1; i >= 0; i--) {
            let p = bgParticles[i];
            if (p.isShooting) {
                p.x -= p.speed * Math.cos(p.angle); p.y += p.speed * Math.sin(p.angle); p.alpha -= 0.02;
                fxCtx.beginPath(); fxCtx.moveTo(p.x, p.y); fxCtx.lineTo(p.x + p.len * Math.cos(p.angle), p.y - p.len * Math.sin(p.angle));
                fxCtx.strokeStyle = `rgba(255, 255, 255, ${p.alpha})`; fxCtx.lineWidth = 1.5; fxCtx.stroke();
                if (p.alpha <= 0) bgParticles.splice(i, 1);
            } else {
                p.alpha += p.speedAlpha; if(p.alpha <= 0.1 || p.alpha >= 0.8) p.speedAlpha *= -1;
                fxCtx.beginPath(); fxCtx.arc(p.x, p.y, p.radius, 0, Math.PI*2);
                fxCtx.fillStyle = `rgba(255, 255, 255, ${p.alpha})`; fxCtx.fill();
            }
        }
        reqFx = requestAnimationFrame(render);
    }
    render();
}

function stopEventBg() {
    if(reqFx) cancelAnimationFrame(reqFx);
    if (fxCtx && fxCanvas) fxCtx.clearRect(0, 0, fxCanvas.width, fxCanvas.height);
    magpieTriggered = false;
}

function drawHeart(ctx, x, y, size, alpha, hue) {
    ctx.save(); ctx.translate(x, y); ctx.scale(size, size);
    ctx.fillStyle = `hsla(${hue}, 100%, 60%, ${alpha})`;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.bezierCurveTo(-1, -1, -2, 1, 0, 2); ctx.bezierCurveTo(2, 1, 1, -1, 0, 0); ctx.fill();
    ctx.restore();
}

function triggerMagpies() {
    if (!confCanvas || !confCtx) return;
    playSound('win');
    magpies = [
        { x: -50, y: confCanvas.height/3, color: '0, 229, 255', tx: confCanvas.width/2, ty: confCanvas.height/2, trail: [] },
        { x: confCanvas.width + 50, y: confCanvas.height/3, color: '255, 0, 127', tx: confCanvas.width/2, ty: confCanvas.height/2, trail: [] }
    ];
    hearts = []; magpiePhase = 0;
    if (!reqConf) renderConf();
}

function renderConf() {
    if (!confCanvas || !confCtx) return;
    confCtx.clearRect(0, 0, confCanvas.width, confCanvas.height);
    let active = false;

    if (confParticles.length > 0) {
        confParticles.forEach(p => {
            p.x += p.vx; p.y += p.vy; p.vy += 0.4; p.rot += p.rotSpeed;
            if(p.y < confCanvas.height + 20) {
                active = true; confCtx.save(); confCtx.translate(p.x, p.y); confCtx.rotate(p.rot * Math.PI / 180);
                confCtx.fillStyle = p.color; confCtx.fillRect(-p.size/2, -p.size/2, p.size, p.size); confCtx.restore();
            }
        });
        if (confParticles.every(p => p.y >= confCanvas.height + 20)) confParticles = [];
    }

    if (magpies.length > 0 || hearts.length > 0) {
        active = true;
        if (magpiePhase === 0) {
            let reached = 0;
            magpies.forEach(b => {
                let dx = b.tx - b.x; let dy = b.ty - b.y;
                b.x += dx * 0.08; b.y += dy * 0.08;
                if (Math.abs(dx) < 3 && Math.abs(dy) < 3) reached++;

                b.trail.push({x: b.x, y: b.y});
                if (b.trail.length > 15) b.trail.shift();

                b.trail.forEach((pt, i) => {
                    let ratio = i / b.trail.length;
                    confCtx.beginPath(); confCtx.arc(pt.x, pt.y, 14 * ratio, 0, Math.PI*2);
                    confCtx.fillStyle = `rgba(${b.color}, ${ratio * 0.6})`; confCtx.fill();
                });

                confCtx.shadowBlur = 25; confCtx.shadowColor = `rgb(${b.color})`;
                confCtx.fillStyle = '#ffffff';
                confCtx.beginPath(); confCtx.arc(b.x, b.y, 10, 0, Math.PI*2); confCtx.fill();
                confCtx.shadowBlur = 0;
            });

            if (reached === 2) {
                magpiePhase = 1; magpies = [];
                for(let i=0; i<80; i++) {
                    hearts.push({
                        x: confCanvas.width/2, y: confCanvas.height/2,
                        vx: (Math.random()-0.5)*35, vy: (Math.random()-0.5)*35 - 5,
                        alpha: 1, size: Math.random() * 12 + 6, hue: Math.random() * 40 + 320
                    });
                }
            }
        } else if (magpiePhase === 1) {
            hearts.forEach(h => {
                h.x += h.vx; h.y += h.vy; h.vy += 0.8; h.alpha -= 0.015;
                if (h.alpha > 0) drawHeart(confCtx, h.x, h.y, h.size, h.alpha, h.hue);
            });
            if (hearts.every(h => h.alpha <= 0)) { hearts = []; magpieTriggered = false; }
        }
    }

    if(active) reqConf = requestAnimationFrame(renderConf); else reqConf = null;
}

function triggerConfetti() {
    if (!confCanvas) return;
    playSound('win'); confParticles = [];
    for(let i=0; i<120; i++) {
        let isLeft = Math.random() < 0.5;
        confParticles.push({
            x: isLeft ? 0 : confCanvas.width, y: confCanvas.height,
            vx: (Math.random() * 12 + 4) * (isLeft ? 1 : -1), vy: -(Math.random() * 18 + 10),
            color: `hsl(${Math.random()*360}, 90%, 65%)`, size: Math.random() * 8 + 6,
            rot: Math.random() * 360, rotSpeed: (Math.random() - 0.5) * 15
        });
    }
    if(!reqConf) renderConf();
}
