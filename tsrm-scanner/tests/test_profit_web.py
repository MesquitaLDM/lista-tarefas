"""Teste ponta a ponta da leitura contra uma página que imita o Profit Web
(gráfico em canvas + legenda A/M/M/F e médias que muda com o cursor)."""
import os
import socket
import subprocess
import time
import urllib.request
from pathlib import Path

import pytest
import yaml

playwright = pytest.importorskip("playwright.sync_api")

from tsrm_scanner import analise  # noqa: E402
from tsrm_scanner.profit_web import ProfitWeb  # noqa: E402

PAGINA = Path(__file__).parent / "fixtures" / "profit_falso.html"
CONFIG = """
url_contem: "profit_falso"
candles_por_tf: {M: 40, S: 40, D: 40, "60": 10, "15": 10}
grafico: {seletor: "#c", margem_direita_px: 72, passo_px: 2, espera_hover_s: 0.0}
legenda: {modo: dom, seletor: ".legend"}
acoes:
  trocar_ativo: [{clicar_grafico: true}, {digitar: "{ticker}"}, {tecla: Enter, esperar: 0.2}]
  timeframes:
    M: [{clicar: 'text="1M"', esperar: 0.2}]
    S: [{clicar: 'text="1S"', esperar: 0.2}]
    D: [{clicar: 'text="1D"', esperar: 0.2}]
    "60": [{clicar: 'text="60"', esperar: 0.2}]
    "15": [{clicar: 'text="15"', esperar: 0.2}]
  ir_para_fim: [{tecla: ArrowRight, vezes: 3}]
"""


def _porta_livre():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def navegador(tmp_path):
    """Chromium em processo separado com porta CDP, como o Chrome do usuário."""
    exe = os.environ.get("TSRM_CHROMIUM")
    if not exe:
        with playwright.sync_playwright() as p:
            exe = p.chromium.executable_path
    if not Path(exe).exists():
        pytest.skip(f"Chromium indisponível em {exe} (defina TSRM_CHROMIUM)")
    porta = _porta_livre()
    proc = subprocess.Popen([exe, "--headless=new", "--no-sandbox", f"--remote-debugging-port={porta}",
                             f"--user-data-dir={tmp_path / 'perfil'}", "--window-size=1200,700", PAGINA.as_uri()],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    url = f"http://127.0.0.1:{porta}"
    for _ in range(60):
        try:
            urllib.request.urlopen(url + "/json/version", timeout=1)
            break
        except OSError:
            time.sleep(0.25)
    yield url
    proc.terminate()
    proc.wait(timeout=10)


def test_leitura_bate_com_a_pagina(navegador, tmp_path):
    cfg = yaml.safe_load(CONFIG)
    cfg["cdp_url"] = navegador
    with ProfitWeb(cfg, tmp_path, verbose=False) as pw:
        dados = pw.ler_ativo("PETR4", ["D"])
        verdade = pw.page.evaluate("verdade()")  # último candle FECHADO na página
        dados.update(pw.ler_ativo("PETR4", ["60"]))
    d = dados["D"]
    assert len(d) == 40 and len(dados["60"]) == 10
    ult = d.iloc[-1]
    assert ult["close"] == round(verdade["c"], 2)
    assert ult["high"] == round(verdade["h"], 2)
    assert ult["mme400"] == round(verdade["e400"], 2)
    assert (tmp_path / "PETR4_D.png").exists()
    assert analise.ler_tf("D", d).zona_magicas in ("acima", "entre", "abaixo")
