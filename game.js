'use strict';

/* ============================================================
   F1 TRACKER — Mini-Game (lazy-loaded)
   ============================================================ */

class F1Game {
    constructor(canvas) {
        this.canvas  = canvas;
        this.ctx     = canvas.getContext('2d');
        this.W       = 360;
        this.H       = 560;
        canvas.width  = this.W;
        canvas.height = this.H;
        canvas.style.maxWidth = '100%';

        /* Layout */
        this.RL = 40;
        this.RR = this.W - 40;
        this.RW = this.RR - this.RL;
        this.LW = this.RW / 3;
        this.LANES = [this.RL + this.LW * 0.5, this.RL + this.LW * 1.5, this.RL + this.LW * 2.5];
        this.CW = 28; this.CH = 52;

        /* State */
        this.phase       = 'start';
        this.frame       = 0;
        this.speed       = 3.5;
        this.score       = 0;
        this.highScore   = parseInt(localStorage.getItem('f1_game_hs') || '0');
        this.roadOffset  = 0;
        this.crashFrame  = 0;

        /* Player */
        this.playerLane    = 1;
        this.playerX       = this.LANES[1];
        this.playerTargetX = this.LANES[1];
        this.playerY       = this.H - 80;

        /* Obstacles */
        this.obstacles       = [];
        this.nextObstacleIn  = 70;
        this.OB_COLORS       = ['#27F4D2','#3671C6','#FF8000','#229971','#6692FF','#B6BABD','#FF87BC'];

        this._raf      = null;
        this._keydown  = e => this._handleKey(e);
        document.addEventListener('keydown', this._keydown);

        canvas.addEventListener('click', e => {
            if (this.phase !== 'playing') { this.restart(); return; }
            const rect = canvas.getBoundingClientRect();
            const scaleX = this.W / rect.width;
            const cx = (e.clientX - rect.left) * scaleX;
            this.movePlayer(cx < this.W / 2 ? -1 : 1);
        });
    }

    start() { this.running = true; this._loop(); }

    stop() {
        this.running = false;
        document.removeEventListener('keydown', this._keydown);
        if (this._raf) cancelAnimationFrame(this._raf);
    }

    restart() {
        this.phase = 'playing';
        this.frame = this.score = this.crashFrame = 0;
        this.speed = 3.5; this.roadOffset = 0;
        this.playerLane = 1;
        this.playerX = this.playerTargetX = this.LANES[1];
        this.obstacles = []; this.nextObstacleIn = 70;
    }

    movePlayer(dir) {
        if (this.phase === 'start' || this.phase === 'crashed') { this.restart(); return; }
        this.playerLane = Math.max(0, Math.min(2, this.playerLane + dir));
        this.playerTargetX = this.LANES[this.playerLane];
    }

    _handleKey(e) {
        if (e.key === 'ArrowLeft')  { e.preventDefault(); this.movePlayer(-1); }
        if (e.key === 'ArrowRight') { e.preventDefault(); this.movePlayer(1); }
        if ((e.key === ' ' || e.key === 'Enter') && this.phase !== 'playing') { e.preventDefault(); this.restart(); }
    }

    _spawnObstacle() {
        const recent = this.obstacles.slice(-2).map(o => o.lane);
        let lane, tries = 0;
        do { lane = Math.floor(Math.random() * 3); tries++; } while (recent.includes(lane) && tries < 6);
        this.obstacles.push({
            lane, x: this.LANES[lane], y: -this.CH - 20,
            color: this.OB_COLORS[Math.floor(Math.random() * this.OB_COLORS.length)],
        });
    }

    _update() {
        if (this.phase !== 'playing') return;
        this.frame++;
        this.score    = Math.floor(this.frame / 6);
        this.speed    = 3.5 + this.frame * 0.0025;
        this.roadOffset = (this.roadOffset + this.speed) % 60;
        this.playerX += (this.playerTargetX - this.playerX) * 0.18;

        this.obstacles.forEach(o => o.y += this.speed);
        this.obstacles = this.obstacles.filter(o => o.y < this.H + this.CH);

        this.nextObstacleIn--;
        if (this.nextObstacleIn <= 0) {
            this._spawnObstacle();
            this.nextObstacleIn = Math.max(28, 70 - this.speed * 4) + Math.random() * 30;
        }

        for (const o of this.obstacles) {
            if (Math.abs(o.x - this.playerX) < this.CW - 6 && Math.abs(o.y - this.playerY) < this.CH - 8) {
                this.phase = 'crashed';
                this.crashFrame = 0;
                if (this.score > this.highScore) {
                    this.highScore = this.score;
                    localStorage.setItem('f1_game_hs', this.highScore);
                    const el = document.getElementById('gameHsDisplay');
                    if (el) el.textContent = this.highScore;
                }
                addToLeaderboard(this.score);
                const lbEl = document.getElementById('game-leaderboard');
                if (lbEl) lbEl.innerHTML = renderLeaderboard(this.score);
                break;
            }
        }
    }

    _loop() {
        if (!this.running) return;
        this._update();
        this._draw();
        this._raf = requestAnimationFrame(() => this._loop());
    }

    _draw() {
        const ctx = this.ctx, W = this.W, H = this.H;
        ctx.clearRect(0, 0, W, H);

        ctx.fillStyle = '#2d5a1b';  ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = '#336622';
        ctx.fillRect(0, 0, this.RL, H);
        ctx.fillRect(this.RR, 0, W - this.RR, H);

        ctx.fillStyle = '#3a3a3a'; ctx.fillRect(this.RL, 0, this.RW, H);

        const kerbH = 18;
        for (let y = -kerbH; y < H + kerbH; y += kerbH * 2) {
            ctx.fillStyle = '#cc0000';
            ctx.fillRect(this.RL - 8, y + (this.roadOffset % (kerbH * 2)), 8, kerbH);
            ctx.fillStyle = '#fff';
            ctx.fillRect(this.RL - 8, y + kerbH + (this.roadOffset % (kerbH * 2)), 8, kerbH);
            ctx.fillStyle = '#cc0000';
            ctx.fillRect(this.RR, y + (this.roadOffset % (kerbH * 2)), 8, kerbH);
            ctx.fillStyle = '#fff';
            ctx.fillRect(this.RR, y + kerbH + (this.roadOffset % (kerbH * 2)), 8, kerbH);
        }

        ctx.strokeStyle = '#fff'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(this.RL, 0); ctx.lineTo(this.RL, H); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(this.RR, 0); ctx.lineTo(this.RR, H); ctx.stroke();

        ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 2;
        ctx.setLineDash([28, 28]); ctx.lineDashOffset = -this.roadOffset;
        for (let i = 1; i <= 2; i++) {
            const lx = this.RL + this.LW * i;
            ctx.beginPath(); ctx.moveTo(lx, 0); ctx.lineTo(lx, H); ctx.stroke();
        }
        ctx.setLineDash([]);

        this.obstacles.forEach(o => this._drawCar(ctx, o.x, o.y, o.color, false));

        if (this.phase !== 'crashed' || this.crashFrame < 15) {
            this._drawCar(ctx, this.playerX, this.playerY, '#E8002D', true);
        }

        if (this.phase === 'crashed') {
            this.crashFrame++;
            const r = this.crashFrame * 4;
            const alpha = Math.max(0, 1 - this.crashFrame / 25);
            ctx.fillStyle = `rgba(255, 140, 0, ${alpha * 0.9})`;
            ctx.beginPath(); ctx.arc(this.playerX, this.playerY, r, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = `rgba(255, 255, 0, ${alpha * 0.6})`;
            ctx.beginPath(); ctx.arc(this.playerX, this.playerY, r * 0.5, 0, Math.PI * 2); ctx.fill();
        }

        ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, 0, W, 46);
        ctx.font = 'bold 13px Inter, sans-serif';
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'left';  ctx.fillText(`SCORE  ${String(this.score).padStart(4,'0')}`, this.RL + 2, 30);
        ctx.textAlign = 'center'; ctx.fillText(`${Math.floor(200 + this.frame * 0.12)} km/h`, W / 2, 30);
        ctx.textAlign = 'right';  ctx.fillText(`BEST   ${String(this.highScore).padStart(4,'0')}`, this.RR - 2, 30);

        if (this.phase === 'start') {
            this._drawOverlay(ctx, W, H, 'BOX BOX RACER', 'Dodge the backmarkers!', '◀ ▶  or tap sides to steer');
        }

        if (this.phase === 'crashed' && this.crashFrame > 35) {
            const newBest = this.score >= this.highScore && this.score > 0;
            this._drawOverlay(ctx, W, H, 'CRASH OUT!',
                newBest ? `NEW BEST: ${this.score}` : `SCORE: ${this.score}`,
                'Tap or press SPACE to restart');
        }
    }

    _drawOverlay(ctx, W, H, title, line1, line2) {
        ctx.fillStyle = 'rgba(0,0,0,0.72)'; ctx.fillRect(0, 0, W, H);
        ctx.textAlign = 'center';
        ctx.fillStyle = '#E8002D';
        ctx.font = 'bold 34px Inter, sans-serif';
        ctx.fillText(title, W / 2, H / 2 - 36);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 17px Inter, sans-serif';
        ctx.fillText(line1, W / 2, H / 2 + 4);
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.font = '13px Inter, sans-serif';
        ctx.fillText(line2, W / 2, H / 2 + 32);
    }

    _drawCar(ctx, x, y, color, isPlayer) {
        const hw = this.CW / 2, hh = this.CH / 2;
        ctx.save();
        ctx.translate(x, y);

        ctx.fillStyle = 'rgba(0,0,0,0.28)';
        this._rrect(ctx, -hw + 2, -hh + 2, this.CW, this.CH, 4);

        ctx.fillStyle = this._shade(color, 0.8);
        ctx.fillRect(-hw - 6, -hh * 0.15, 6, hh * 0.75);
        ctx.fillRect(hw, -hh * 0.15, 6, hh * 0.75);

        ctx.fillStyle = color;
        this._rrect(ctx, -hw, -hh, this.CW, this.CH, 4);

        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(-hw * 0.42, -hh);
        ctx.lineTo(hw * 0.42, -hh);
        ctx.lineTo(0, -hh - hh * 0.42);
        ctx.closePath(); ctx.fill();

        ctx.fillStyle = this._shade(color, 0.65);
        ctx.fillRect(-hw - 5, -hh + 2, this.CW + 10, 4);

        ctx.fillStyle = this._shade(color, 0.65);
        ctx.fillRect(-hw - 7, hh - 8, this.CW + 14, 4);

        ctx.fillStyle = '#0a0a18';
        ctx.beginPath();
        ctx.ellipse(0, -hh * 0.06, hw * 0.38, hh * 0.2, 0, 0, Math.PI * 2); ctx.fill();

        ctx.fillStyle = isPlayer ? '#FFD700' : '#aaa';
        ctx.beginPath();
        ctx.arc(0, -hh * 0.06, hw * 0.2, 0, Math.PI * 2); ctx.fill();

        ctx.restore();
    }

    _rrect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath(); ctx.fill();
    }

    _shade(hex, f) {
        if (!hex.startsWith('#') || hex.length < 7) return hex;
        const r = Math.floor(parseInt(hex.slice(1,3),16)*f);
        const g = Math.floor(parseInt(hex.slice(3,5),16)*f);
        const b = Math.floor(parseInt(hex.slice(5,7),16)*f);
        return `rgb(${r},${g},${b})`;
    }
}

/* Expose to global scope for app.js */
window.F1Game = F1Game;
