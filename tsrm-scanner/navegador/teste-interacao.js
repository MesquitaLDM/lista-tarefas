// TSRM Scanner — teste de interação que roda dentro da aba do Profit Web (sem instalar nada).
// Acha o gráfico, simula o cursor passando sobre ele e mostra o que mudou na página (a legenda).
(async () => {
  const esperar = ms => new Promise(r => setTimeout(r, ms));
  const res = [];
  const item = (ok, msg) => res.push({ok, msg});

  const canvases = [...document.querySelectorAll('canvas')]
    .map(c => ({c, r: c.getBoundingClientRect()}))
    .filter(o => o.r.width > 200 && o.r.height > 100)
    .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height);
  if (!canvases.length) {
    item(false, 'Nenhum gráfico (canvas) encontrado nesta aba. O gráfico está aberto e visível?');
  } else {
    const {c, r} = canvases[0];
    item(true, `Gráfico encontrado: ${Math.round(r.width)}x${Math.round(r.height)} px`);
    const mover = (x, y) => {
      // A biblioteca do gráfico pode escutar no canvas ou num elemento acima dele.
      const alvo = document.elementFromPoint(x, y) || c;
      const base = {clientX: x, clientY: y, bubbles: true, cancelable: true, view: window};
      alvo.dispatchEvent(new PointerEvent('pointermove', {...base, pointerType: 'mouse', isPrimary: true}));
      alvo.dispatchEvent(new MouseEvent('mousemove', base));
    };
    const y = r.top + r.height * 0.45;
    const textos = [];
    for (const f of [0.2, 0.35, 0.5, 0.65, 0.8]) {
      mover(r.left + r.width * f, y);
      await esperar(400);
      textos.push(document.body.innerText.split('\n'));
    }
    const base = new Set(textos[0]);
    const mudaram = [...new Set(textos.slice(1).flat().filter(l => l.trim() && !base.has(l)))];
    if (mudaram.length) {
      item(true, 'O gráfico respondeu ao cursor simulado e a legenda é texto legível. Linhas que mudaram:');
      mudaram.slice(0, 12).forEach(l => res.push({ok: null, msg: l.slice(0, 160)}));
    } else {
      item(false, 'Nada mudou na página com o cursor simulado (o gráfico pode ignorar cursor simulado, ' +
        'ou a legenda é desenhada dentro do gráfico).');
    }
  }

  // Painel de resultado.
  document.getElementById('tsrm-teste')?.remove();
  const p = document.createElement('div');
  p.id = 'tsrm-teste';
  p.style.cssText = 'position:fixed;top:20px;right:20px;z-index:2147483647;max-width:620px;max-height:80vh;' +
    'overflow:auto;background:#fff;color:#111;font:13px/1.4 Arial,sans-serif;padding:14px 16px;' +
    'border:2px solid #2c3e50;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.35);white-space:pre-wrap';
  const ok = res.every(i => i.ok !== false);
  p.innerHTML = `<b style="font-size:15px">TSRM — teste de interação: ${ok ? '✅ funcionando' : '⚠️ ver itens'}</b>` +
    '<button style="float:right" onclick="this.parentNode.remove()">fechar</button>\n\n';
  for (const i of res) {
    const d = document.createElement('div');
    d.textContent = (i.ok === true ? '✅ ' : i.ok === false ? '❌ ' : '      ') + i.msg;
    if (i.ok === null) d.style.cssText = 'font-family:monospace;font-size:12px;color:#333';
    p.appendChild(d);
  }
  const copiar = document.createElement('button');
  copiar.textContent = 'copiar resultado';
  copiar.style.marginTop = '10px';
  copiar.onclick = () => navigator.clipboard.writeText(res.map(i => i.msg).join('\n'));
  p.appendChild(copiar);
  document.body.appendChild(p);
})();
