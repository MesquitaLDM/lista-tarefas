"""Linha de comando do TSRM Scanner.

    python -m tsrm_scanner abrir-chrome          # abre o Chrome com porta de depuração
    python -m tsrm_scanner inspecionar           # ajuda a configurar seletores da legenda
    python -m tsrm_scanner testar-leitura PETR4 --tf D
    python -m tsrm_scanner analisar              # varre os ativos e gera o relatório
"""
import argparse
import os
import platform
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

import pandas as pd
import yaml

from . import NOME_TF, TIMEFRAMES, analise, relatorio

RAIZ = Path(__file__).resolve().parent.parent


def carregar_config(caminho: str | None) -> dict:
    p = Path(caminho) if caminho else RAIZ / "config.yaml"
    if not p.exists():
        exemplo = RAIZ / "config.exemplo.yaml"
        print(f"[aviso] {p} não existe — usando {exemplo.name}. Copie-o para config.yaml e ajuste.")
        p = exemplo
    with open(p, encoding="utf-8") as f:
        return yaml.safe_load(f)


def carregar_ativos(arg: str | None, cfg: dict) -> list[str]:
    fonte = arg or cfg.get("arquivo_ativos", str(RAIZ / "ativos.txt"))
    if Path(fonte).exists():
        linhas = Path(fonte).read_text(encoding="utf-8").splitlines()
    else:
        linhas = fonte.replace(";", ",").split(",")
    return [l.split("#")[0].strip().upper() for l in linhas if l.split("#")[0].strip()]


def _parametros(cfg: dict) -> analise.Parametros:
    return analise.Parametros(**cfg.get("parametros", {}))


# ── abrir-chrome ──────────────────────────────────────────────────────────────

def _achar_chrome() -> str | None:
    candidatos = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ]
    for c in candidatos:
        if Path(c).exists():
            return c
    return shutil.which("google-chrome") or shutil.which("chromium") or shutil.which("chrome")


def cmd_abrir_chrome(a, cfg):
    chrome = a.chrome or cfg.get("chrome") or _achar_chrome()
    if not chrome:
        sys.exit("Chrome não encontrado. Informe o caminho com --chrome.")
    perfil = Path(a.perfil or cfg.get("perfil_chrome") or (RAIZ / "perfil-chrome")).resolve()
    porta = cfg.get("cdp_url", "http://127.0.0.1:9222").rsplit(":", 1)[-1].strip("/")
    args = [chrome, f"--remote-debugging-port={porta}", f"--user-data-dir={perfil}",
            "--no-first-run", "--start-maximized"]
    if cfg.get("url_profit"):
        args.append(cfg["url_profit"])
    kw = {"creationflags": 0x00000008} if platform.system() == "Windows" else {"start_new_session": True}
    subprocess.Popen(args, **kw)
    print(f"Chrome aberto (porta {porta}, perfil {perfil}).\n"
          "Faça login no Profit Web nessa janela e deixe o gráfico aberto. O login fica salvo nesse perfil.")


# ── inspecionar / testar ──────────────────────────────────────────────────────

def cmd_inspecionar(a, cfg):
    from .profit_web import inspecionar
    inspecionar(cfg, RAIZ / "inspecao")


def cmd_testar(a, cfg):
    from .profit_web import ProfitWeb
    tfs = a.tf.split(",") if a.tf else ["D"]
    with ProfitWeb(cfg, RAIZ / "inspecao") as pw:
        dados = pw.ler_ativo(a.ticker.upper(), tfs)
    pd.set_option("display.width", 200)
    pd.set_option("display.max_columns", 30)
    for tf, df in dados.items():
        print(f"\n{NOME_TF[tf]} — {len(df)} candles fechados (último = mais recente):")
        print(df.tail(10).to_string())
        leitura = analise.ler_tf(tf, df)
        print(f"Leitura TSRM: {leitura.resumo()}")


# ── analisar ──────────────────────────────────────────────────────────────────

def _ler_csv(pasta: Path, ticker: str) -> dict:
    out = {}
    for tf in TIMEFRAMES:
        p = pasta / f"{ticker}_{tf}.csv"
        if p.exists():
            out[tf] = pd.read_csv(p)
    return out


def cmd_analisar(a, cfg):
    ativos = carregar_ativos(a.ativos, cfg)
    tfs = a.tfs.split(",") if a.tfs else TIMEFRAMES
    carimbo = datetime.now().strftime("%Y-%m-%d_%H%M")
    saida = Path(a.saida or cfg.get("pasta_relatorios", RAIZ / "relatorios")) / carimbo
    pasta_dados = Path(a.dados) if a.dados else saida / "dados"
    capturas = saida / "capturas"
    saida.mkdir(parents=True, exist_ok=True)
    pasta_dados.mkdir(parents=True, exist_ok=True)
    params = _parametros(cfg)

    resultados = []
    if a.fonte == "csv":
        for t in ativos:
            resultados.append(analise.classificar(t, _ler_csv(pasta_dados, t), params))
        capturas = None
    else:
        from .profit_web import ProfitWeb
        with ProfitWeb(cfg, capturas) as pw:
            for i, t in enumerate(ativos, 1):
                print(f"[{i}/{len(ativos)}] {t}")
                try:
                    dados = pw.ler_ativo(t, tfs)
                except Exception as e:  # noqa: BLE001
                    print(f"  falha: {e}")
                    dados = {}
                for tf, df in dados.items():
                    df.to_csv(pasta_dados / f"{t}_{tf}.csv", index=False)
                r = analise.classificar(t, dados, params)
                print(f"  → {r.rating}")
                resultados.append(r)

    resultados = analise.ordenar(resultados)
    relatorio.imprimir(resultados)
    pdf = relatorio.gerar_pdf(resultados, saida / f"TSRM_{carimbo}.pdf", capturas)
    xlsx = relatorio.gerar_excel(resultados, saida / f"TSRM_{carimbo}.xlsx")
    print(f"\nRelatórios:\n  {pdf}\n  {xlsx}\n  Dados lidos (CSV): {pasta_dados}")


def main(argv=None):
    ap = argparse.ArgumentParser(prog="tsrm_scanner", description="Leitura do Profit Web + análise TSRM")
    ap.add_argument("--config", help="caminho do config.yaml")
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("abrir-chrome", help="abre o Chrome com porta de depuração para o programa se conectar")
    s.add_argument("--chrome")
    s.add_argument("--perfil")
    s.set_defaults(fn=cmd_abrir_chrome)

    s = sub.add_parser("inspecionar", help="lista elementos da página para configurar a leitura")
    s.set_defaults(fn=cmd_inspecionar)

    s = sub.add_parser("testar-leitura", help="lê um ativo e mostra os candles extraídos")
    s.add_argument("ticker")
    s.add_argument("--tf", help="ex.: D ou M,S,D,60,15")
    s.set_defaults(fn=cmd_testar)

    s = sub.add_parser("analisar", help="varre a lista de ativos e gera PDF + Excel")
    s.add_argument("--ativos", help="arquivo .txt (1 ticker por linha) ou lista 'PETR4,VALE3'")
    s.add_argument("--fonte", choices=["profit", "csv"], default="profit",
                   help="profit = lê a tela; csv = reanalisa CSVs de uma leitura anterior (--dados)")
    s.add_argument("--dados", help="pasta com CSVs TICKER_TF.csv")
    s.add_argument("--saida", help="pasta dos relatórios")
    s.add_argument("--tfs", help="subconjunto de TFs, ex.: M,S,D")
    s.set_defaults(fn=cmd_analisar)

    a = ap.parse_args(argv)
    a.fn(a, carregar_config(a.config))
