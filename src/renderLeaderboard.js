// src/renderLeaderboard.js
const { createCanvas } = require("@napi-rs/canvas");

/**
 * Render a leaderboard as a PNG buffer (dark theme + HeisenXP colors).
 *
 * entries: Array<{ rank: number, name: string, xp: number, level: number }>
 * Returns: Buffer (PNG)
 */
function renderLeaderboardPng(entries) {
    // Always Top 10, always render 10 rows to guarantee consistent height
    const ROW_COUNT = 10;
    const top = entries.slice(0, ROW_COUNT);

    // Layout
    const width = 900;
    const padding = 28;

    const headerH = 110;

    // Row block
    const rowStep = 70;   // vertical step per row (more spacing)
    const rowBoxH = 56;   // actual row rectangle height
    const gapAfterHeader = 22;

    // Extra safe space at bottom so Discord preview doesn't clip
    const bottomPad = 48;

    const height =
    padding +
    headerH +
    gapAfterHeader +
    ROW_COUNT * rowStep +
    bottomPad;

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");

    // Theme colors (match logo vibe: cyan + green on dark)
    const bg0 = "#070A12";
    const bg1 = "#0B1224";
    const panel = "#0F1A33";
    const panelEdge = "rgba(0, 220, 255, 0.22)";
    const text = "#EAF2FF";
    const subtext = "rgba(234, 242, 255, 0.72)";
    const cyan = "#00D8FF";
    const green = "#57FF9A";

    // Medal colors
    const gold = "#F6C453";
    const silver = "#C9D1D9";
    const bronze = "#C67C4E";

    // Helpers
    const roundRect = (x, y, w, h, r) => {
        const rr = Math.min(r, w / 2, h / 2);
        ctx.beginPath();
        ctx.moveTo(x + rr, y);
        ctx.arcTo(x + w, y, x + w, y + h, rr);
        ctx.arcTo(x + w, y + h, x, y + h, rr);
        ctx.arcTo(x, y + h, x, y, rr);
        ctx.arcTo(x, y, x + w, y, rr);
        ctx.closePath();
    };

    const drawGlowLine = (x1, y1, x2, y2, color, widthPx, blur) => {
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = widthPx;
        ctx.shadowColor = color;
        ctx.shadowBlur = blur;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        ctx.restore();
    };

    const measureFitText = (str, maxW, font) => {
        ctx.font = font;
        if (ctx.measureText(str).width <= maxW) return str;
        let s = str;
        while (s.length > 1 && ctx.measureText(s + "…").width > maxW) {
            s = s.slice(0, -1);
        }
        return s + "…";
    };

    const drawMedal = (x, y, rank) => {
        let fill = null;
        if (rank === 1) fill = gold;
        else if (rank === 2) fill = silver;
        else if (rank === 3) fill = bronze;
        else return;

        ctx.save();
        // outer glow
        ctx.shadowColor = fill;
        ctx.shadowBlur = 14;

        ctx.fillStyle = fill;
        ctx.beginPath();
        ctx.arc(x, y, 16, 0, Math.PI * 2);
        ctx.fill();

        // inner ring
        ctx.shadowBlur = 0;
        ctx.strokeStyle = "rgba(0,0,0,0.25)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, 14, 0, Math.PI * 2);
        ctx.stroke();

        // number
        ctx.fillStyle = "#0A0F1E";
        ctx.font = "bold 14px system-ui, -apple-system, Segoe UI, Roboto, Arial";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(rank), x, y + 0.5);

        ctx.restore();
    };

    // Background gradient
    const g = ctx.createLinearGradient(0, 0, 0, height);
    g.addColorStop(0, bg0);
    g.addColorStop(1, bg1);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, width, height);

    // Header panel
    const headerX = padding;
    const headerY = padding;
    const headerW = width - padding * 2;

    roundRect(headerX, headerY, headerW, headerH, 22);
    ctx.fillStyle = panel;
    ctx.fill();

    // Header edge glow
    ctx.save();
    ctx.strokeStyle = panelEdge;
    ctx.lineWidth = 2;
    ctx.shadowColor = cyan;
    ctx.shadowBlur = 18;
    ctx.stroke();
    ctx.restore();

    // Accent lines
    drawGlowLine(
        headerX + 22,
        headerY + headerH - 18,
        headerX + headerW - 22,
        headerY + headerH - 18,
        "rgba(0,216,255,0.35)",
                 2,
                 10
    );
    drawGlowLine(
        headerX + 22,
        headerY + headerH - 16,
        headerX + headerW - 22,
        headerY + headerH - 16,
        "rgba(87,255,154,0.22)",
                 2,
                 10
    );

    // Title
    ctx.save();
    ctx.fillStyle = text;
    ctx.font = "800 34px system-ui, -apple-system, Segoe UI, Roboto, Arial";
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.fillText("HeisenXP Leaderboard", headerX + 28, headerY + 22);

    // Subtitle
    ctx.fillStyle = subtext;
    ctx.font = "500 16px system-ui, -apple-system, Segoe UI, Roboto, Arial";
    ctx.fillText("Top 10 by XP • No pings • Quantum-approved", headerX + 30, headerY + 62);
    ctx.restore();

    // Rows
    const startY = headerY + headerH + gapAfterHeader;
    const maxXp = Math.max(1, ...top.map(e => e.xp || 0));

    for (let i = 0; i < ROW_COUNT; i++) {
        const entry = top[i] || { rank: i + 1, name: "—", xp: 0, level: 0 };
        const rowX = padding;
        const rowY = startY + i * rowStep;
        const rowW = width - padding * 2;

        // Row background
        roundRect(rowX, rowY, rowW, rowBoxH, 18);
        ctx.fillStyle = i % 2 === 0 ? "rgba(15,26,51,0.86)" : "rgba(12,20,40,0.84)";
        ctx.fill();

        // Subtle edge
        ctx.save();
        ctx.strokeStyle = "rgba(0, 216, 255, 0.10)";
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();

        const leftPad = rowX + 22;
        const midY = rowY + rowBoxH / 2;

        // Medal / rank
        if (entry.rank <= 3) {
            drawMedal(leftPad + 18, midY, entry.rank);
        } else {
            ctx.save();
            ctx.fillStyle = "rgba(234, 242, 255, 0.65)";
            ctx.font = "700 16px system-ui, -apple-system, Segoe UI, Roboto, Arial";
            ctx.textAlign = "left";
            ctx.textBaseline = "middle";
            ctx.fillText(`${entry.rank}.`, leftPad + 8, midY);
            ctx.restore();
        }

        // Name (truncate to fit)
        const nameX = leftPad + 58;
        const nameMaxW = rowW * 0.46;

        ctx.save();
        ctx.fillStyle = text;
        ctx.font = "800 18px system-ui, -apple-system, Segoe UI, Roboto, Arial";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        const safeName = measureFitText(String(entry.name ?? "—"), nameMaxW, ctx.font);
        ctx.fillText(safeName, nameX, midY);
        ctx.restore();

        // XP text
        const xpText = `${entry.xp} XP`;
        ctx.save();
        ctx.fillStyle = "rgba(234, 242, 255, 0.86)";
        ctx.font = "700 16px system-ui, -apple-system, Segoe UI, Roboto, Arial";
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        ctx.fillText(xpText, rowX + rowW - 22, midY - 9);
        ctx.restore();

        // Level text
        const lvlText = `Lvl ${entry.level}`;
        ctx.save();
        ctx.fillStyle = "rgba(234, 242, 255, 0.70)";
        ctx.font = "600 14px system-ui, -apple-system, Segoe UI, Roboto, Arial";
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        ctx.fillText(lvlText, rowX + rowW - 22, midY + 12);
        ctx.restore();

        // XP bar
        const barX = rowX + rowW * 0.60;
        const barY = rowY + rowBoxH - 14;
        const barW = rowW * 0.34;
        const barH = 10;

        // track
        ctx.save();
        roundRect(barX, barY, barW, barH, 6);
        ctx.fillStyle = "rgba(255,255,255,0.08)";
        ctx.fill();

        // fill
        const pct = Math.max(0, Math.min(1, (entry.xp || 0) / maxXp));
        const fillW = Math.max(0, Math.floor(barW * pct));

        const barGrad = ctx.createLinearGradient(barX, 0, barX + barW, 0);
        barGrad.addColorStop(0, cyan);
        barGrad.addColorStop(1, green);

        roundRect(barX, barY, fillW, barH, 6);
        ctx.fillStyle = barGrad;
        ctx.shadowColor = cyan;
        ctx.shadowBlur = 10;
        ctx.fill();

        ctx.restore();
    }

    return canvas.toBuffer("image/png");
}

module.exports = { renderLeaderboardPng };
