import numpy as np
import pandas as pd
import pytest

from tsrm_scanner import analise, indicadores, leitura, setups


def serie(n, inicio, passo, ruido=0.0, seed=0):
    rng = np.random.default_rng(seed)
    close = inicio + passo * np.arange(n) + rng.normal(0, ruido, n)
    open_ = np.r_[close[0], close[:-1]]
    high = np.maximum(open_, close) * 1.005
    low = np.minimum(open_, close) * 0.995
    return pd.DataFrame({"open": open_, "high": high, "low": low, "close": close, "volume": 1000.0})


def tendencia_alta():
    return {tf: serie(n, 10, 0.05, 0.05, i) for i, (tf, n) in
            enumerate([("M", 450), ("S", 450), ("D", 450), ("60", 450), ("15", 450)])}


# ── leitura ──
@pytest.mark.parametrize("txt,esperado", [("37,50", 37.5), ("1.234,56", 1234.56), ("-0,12", -0.12),
                                           ("37.50", 37.5), ("12,5M", 12.5e6), ("−1,5", -1.5)])
def test_para_float(txt, esperado):
    assert leitura.para_float(txt) == pytest.approx(esperado)


def test_extrair_legenda_profit():
    txt = "PETR4 - Diário  A: 37,50  M: 37,90  M: 37,20  F: 37,80  V: +0,80%\nMMS (3) 37,61  MME (9) 37,10  MMS (21) 36,02  MMA (200) 33,40  MME (400) 31,95"
    v = leitura.extrair(txt)
    assert (v["open"], v["high"], v["low"], v["close"]) == (37.5, 37.9, 37.2, 37.8)
    assert v["mms3"] == 37.61 and v["mme9"] == 37.10 and v["mms21"] == 36.02
    assert v["mma200"] == 33.40 and v["mme400"] == 31.95
    assert leitura.valido(v)


def test_extrair_posicional():
    v = leitura.extrair("10,0 11,0 9,5 10,5 +1% 10,2", ordem=["open", "high", "low", "close", None, "mms3"])
    assert v == {"open": 10.0, "high": 11.0, "low": 9.5, "close": 10.5, "mms3": 10.2}


# ── indicadores ──
def test_ifr_limites():
    df = serie(60, 10, 0.1)
    r = indicadores.ifr(df["close"])
    assert r.iloc[-1] == 100.0
    assert indicadores.ifr(serie(60, 20, -0.1)["close"]).iloc[-1] == pytest.approx(0.0)


def test_completar_preserva_valores_lidos():
    df = serie(30, 10, 0.1)
    df["mme400"] = 5.0  # lido da legenda do Profit
    out = indicadores.completar(df)
    assert (out["mme400"] == 5.0).all()
    assert out["mms3"].notna().iloc[-1]


# ── setups ──
def test_agulhada_compra():
    df = serie(30, 10, 0.0, 0.0)
    df = indicadores.completar(df)
    i = df.index[-1]
    df.loc[i, ["open", "close", "high", "low"]] = [9.8, 10.4, 10.5, 9.7]
    df = indicadores.completar(df[["open", "high", "low", "close", "volume"]])
    nomes = [s.nome for s in setups.agulhada(df)]
    assert "Agulhada de compra" in nomes


def test_martelo_no_fundo():
    df = serie(20, 20, -0.3)
    i = df.index[-1]
    df.loc[i, ["open", "high", "low", "close"]] = [14.4, 14.52, 13.6, 14.5]
    assert any(s.nome == "Martelo" for s in setups.padroes_candle(df))


# ── classificação ──
def test_alta_em_todos_tfs_vira_compra():
    r = analise.classificar("TEST3", tendencia_alta(), analise.Parametros(ifr_mensal_max=101, ifr_alta_conviccao=(0, 101)))
    assert r.direcao == "compra"
    assert r.categoria in ("COMPRA", "AGUARDAR")
    assert all(t.zona_magicas == "acima" for t in r.tfs.values())
    assert r.stop is not None and r.stop < float(r.entrada.split()[1].replace(",", "."))


def test_ifr_mensal_sobrecomprado_elimina():
    r = analise.classificar("TEST3", tendencia_alta())
    assert r.categoria == "FICAR QUIETO" and "IFR Mensal" in r.observacoes[-1]


def test_baixa_vira_venda():
    dados = {tf: serie(450, 60, -0.1, 0.05, i) for i, tf in enumerate(["M", "S", "D", "60", "15"])}
    r = analise.classificar("TEST3", dados, analise.Parametros(ifr_mensal_colapso=-1))
    assert r.direcao == "venda" and r.categoria in ("VENDA", "AGUARDAR")


def test_mageica_intraday_teto_vira_aguardar():
    dados = tendencia_alta()
    d60 = serie(450, 40, -0.05, 0.02)  # 60min caindo: mágicas acima do preço
    dados["60"] = d60
    r = analise.classificar("TEST3", dados, analise.Parametros(ifr_mensal_max=101, ifr_alta_conviccao=(0, 101)))
    assert r.categoria != "COMPRA" or r.estrelas < 4
    assert any("60min" in o and "teto" in o for o in r.observacoes)


def test_sem_dados():
    assert analise.classificar("X", {}).categoria == "SEM DADOS"


def test_relatorios(tmp_path):
    from tsrm_scanner import relatorio
    rs = [analise.classificar("TEST3", tendencia_alta(), analise.Parametros(ifr_mensal_max=101, ifr_alta_conviccao=(0, 101))),
          analise.classificar("FQ3", tendencia_alta())]
    relatorio.gerar_pdf(rs, tmp_path / "r.pdf")
    relatorio.gerar_excel(rs, tmp_path / "r.xlsx")
    assert (tmp_path / "r.pdf").stat().st_size > 1000 and (tmp_path / "r.xlsx").exists()
