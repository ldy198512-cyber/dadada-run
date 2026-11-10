// 본부 색상과 달리는 캐릭터 그리기 (큰 화면과 폰 화면이 함께 씁니다)
const TEAM_COLORS = ['#E8453C', '#2F6BFF', '#FFC02E', '#27B96B', '#9A5CE6', '#FF7A1A', '#19B8C9', '#E754A6'];

// x, y = 발이 닿는 땅의 위치, s = 캐릭터 키, ph = 다리 움직임 위상, moving = 달리는 중인지
function drawRunner(ctx, x, y, s, color, ph, moving) {
  const sw = moving ? Math.sin(ph) : 0.18;
  const bob = moving ? Math.abs(Math.cos(ph)) * s * 0.07 : 0;
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = 'rgba(0,0,0,.25)';
  ctx.beginPath(); ctx.ellipse(0, 0, s * 0.3, s * 0.07, 0, 0, Math.PI * 2); ctx.fill();
  ctx.translate(0, -bob);
  ctx.lineCap = 'round';
  // 다리
  const hipY = -s * 0.36, leg = s * 0.33;
  ctx.strokeStyle = '#14202B'; ctx.lineWidth = s * 0.12;
  for (const d of [1, -1]) {
    const a = sw * d * 0.95;
    ctx.beginPath(); ctx.moveTo(d * s * 0.05, hipY);
    ctx.lineTo(d * s * 0.05 + Math.sin(a) * leg, hipY + Math.cos(a) * leg - (moving && a * d < 0 ? s * 0.04 : 0));
    ctx.stroke();
  }
  // 뒤쪽 팔
  const shY = -s * 0.62, arm = s * 0.24;
  ctx.strokeStyle = 'rgba(20,32,43,.55)'; ctx.lineWidth = s * 0.09;
  ctx.beginPath(); ctx.moveTo(-s * 0.05, shY); ctx.lineTo(-s * 0.05 + Math.sin(sw * 1.1) * arm, shY + Math.cos(sw * 1.1) * arm * 0.8); ctx.stroke();
  // 몸통
  ctx.fillStyle = color; ctx.strokeStyle = 'rgba(20,32,43,.85)'; ctx.lineWidth = Math.max(1.5, s * 0.045);
  ctx.beginPath(); ctx.ellipse(0, -s * 0.62, s * 0.27, s * 0.31, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  // 머리띠
  ctx.strokeStyle = '#FFF8EC'; ctx.lineWidth = s * 0.06;
  ctx.beginPath(); ctx.moveTo(-s * 0.23, -s * 0.78); ctx.lineTo(s * 0.23, -s * 0.78); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-s * 0.23, -s * 0.78); ctx.lineTo(-s * 0.36, -s * 0.74 + Math.sin(ph * 2) * s * 0.03); ctx.stroke();
  // 눈
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(s * 0.12, -s * 0.64, s * 0.08, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#14202B'; ctx.beginPath(); ctx.arc(s * 0.15, -s * 0.64, s * 0.04, 0, Math.PI * 2); ctx.fill();
  // 앞쪽 팔
  ctx.strokeStyle = '#14202B'; ctx.lineWidth = s * 0.09;
  ctx.beginPath(); ctx.moveTo(s * 0.02, shY + s * 0.06); ctx.lineTo(s * 0.02 - Math.sin(sw * 1.1) * arm, shY + s * 0.06 + Math.cos(sw * 1.1) * arm * 0.8); ctx.stroke();
  ctx.restore();
}

function fmtTime(ms) { return (ms / 1000).toFixed(2) + '초'; }
