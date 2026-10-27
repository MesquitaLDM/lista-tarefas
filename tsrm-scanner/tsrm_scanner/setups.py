"""Padrões de candle e setups nomeados do TSRM.

Cada função recebe o DataFrame de candles FECHADOS (já com indicadores) e devolve
uma lista de `Sinal`. O último candle do DataFrame é o último candle fechado.
"""
from dataclasses import dataclass

import numpy as np
import pandas as pd

TICK = 0.01


@dataclass
class Sinal:
    nome: str
    direcao: str            # "compra", "venda" ou "neutro"
    gatilho: float | None = None
    stop: float | None = None
    detalhe: str = ""

    def __str__(self):
        partes = [self.nome]
        if self.gatilho is not None:
            partes.append(f"gatilho {self.gatilho:.2f}".replace(".", ","))
        if self.stop is not None:
            partes.append(f"stop {self.stop:.2f}".replace(".", ","))
        return " | ".join(partes)


def _ok(*vals) -> bool:
    return all(v is not None and not (isinstance(v, float) and np.isnan(v)) for v in vals)


def _tendencia_previa(df: pd.DataFrame, n: int = 5) -> str:
    """'alta' / 'baixa' / 'lateral' olhando os n candles anteriores ao último."""
    if len(df) < n + 2:
        return "lateral"
    ini, fim = df["close"].iloc[-n - 2], df["close"].iloc[-2]
    var = (fim - ini) / ini
    return "alta" if var > 0.02 else "baixa" if var < -0.02 else "lateral"


# ── Candles de confirmação ────────────────────────────────────────────────────

def padroes_candle(df: pd.DataFrame) -> list[Sinal]:
    if len(df) < 2:
        return []
    o, h, l, c = (df[k].iloc[-1] for k in ("open", "high", "low", "close"))
    po, pc = df["open"].iloc[-2], df["close"].iloc[-2]
    amplitude = h - l
    if amplitude <= 0:
        return []
    corpo = abs(c - o)
    sup = h - max(o, c)
    inf = min(o, c) - l
    ctx = _tendencia_previa(df)
    out: list[Sinal] = []

    if corpo <= 0.1 * amplitude:
        nome = "Doji (estrela da manhã)" if ctx == "baixa" else "Doji (estrela da tarde)" if ctx == "alta" else "Doji"
        out.append(Sinal(nome, "compra" if ctx == "baixa" else "venda" if ctx == "alta" else "neutro"))
    elif corpo > 0:
        if inf >= 2.5 * corpo and sup <= corpo:
            if ctx == "baixa":
                out.append(Sinal("Martelo", "compra", h + TICK, l))
            elif ctx == "alta":
                out.append(Sinal("Enforcado", "venda", l - TICK, h))
        if sup >= 2.5 * corpo and inf <= corpo:
            if ctx == "baixa":
                out.append(Sinal("Martelo invertido", "compra", h + TICK, l, "precisa confirmação"))
            elif ctx == "alta":
                out.append(Sinal("Estrela cadente", "venda", l - TICK, h))
        if sup <= 0.02 * amplitude and inf <= 0.02 * amplitude:
            out.append(Sinal("Marubozu de " + ("alta" if c > o else "baixa"), "compra" if c > o else "venda"))

    pcorpo_min, pcorpo_max = min(po, pc), max(po, pc)
    if pc < po and c > o and o <= pcorpo_min and c >= pcorpo_max and ctx != "alta":
        out.append(Sinal("Engolfo de alta", "compra", h + TICK, l))
    elif pc > po and c < o and o >= pcorpo_max and c <= pcorpo_min and ctx != "baixa":
        out.append(Sinal("Engolfo de baixa", "venda", l - TICK, h))
    elif pc < po and c > o and o < pc and c > (po + pc) / 2 and c < po and ctx == "baixa":
        out.append(Sinal("Piercing line", "compra", h + TICK, l))
    elif pc > po and c < o and o > pc and c < (po + pc) / 2 and c > po and ctx == "alta":
        out.append(Sinal("Nuvem negra", "venda", l - TICK, h))
    elif abs(pc - po) > 2 * corpo and pcorpo_min < min(o, c) and max(o, c) < pcorpo_max:
        if ctx == "baixa":
            out.append(Sinal("Harami de alta", "compra", h + TICK, l))
        elif ctx == "alta":
            out.append(Sinal("Harami de baixa", "venda", l - TICK, h))
    return out


# ── Setups nomeados ───────────────────────────────────────────────────────────

def agulhada(df: pd.DataFrame, ultimos: int = 3) -> list[Sinal]:
    """Corpo de UMA vela perfura MMS3, MME9 e MMS21 de uma vez."""
    out = []
    for i in range(max(0, len(df) - ultimos), len(df)):
        r = df.iloc[i]
        mms = (r.get("mms3"), r.get("mme9"), r.get("mms21"))
        if not _ok(*mms):
            continue
        idade = len(df) - 1 - i
        quando = "último candle" if idade == 0 else f"há {idade} candle(s)"
        if r["open"] < min(mms) and r["close"] > max(mms):
            out.append(Sinal("Agulhada de compra", "compra", r["high"] + TICK, r["low"], quando))
        elif r["open"] > max(mms) and r["close"] < min(mms):
            out.append(Sinal("Agulhada de venda", "venda", r["low"] - TICK, r["high"], quando))
    return out


def fffd(df: pd.DataFrame) -> list[Sinal]:
    """Fechou Fora, Fechou Dentro (Bollinger 20), conforme o material do skill TSRM."""
    if len(df) < 2:
        return []
    a, b = df.iloc[-2], df.iloc[-1]
    if not _ok(a.get("bb_sup"), a.get("bb_inf"), b.get("bb_sup"), b.get("bb_inf")):
        return []
    out = []
    alvo = b.get("mme9")
    if a["close"] > a["bb_sup"] and b["close"] <= b["bb_sup"]:
        out.append(Sinal("FFFD de compra", "compra", b["high"] + TICK, b["low"],
                         f"alvo próximo MME9 {alvo:.2f}" if _ok(alvo) else ""))
    if a["close"] < a["bb_inf"] and b["close"] >= b["bb_inf"]:
        out.append(Sinal("FFFD de venda", "venda", b["low"] - TICK, b["high"],
                         f"alvo próximo MME9 {alvo:.2f}" if _ok(alvo) else ""))
    return out


def ponto_continuo(df: pd.DataFrame, tolerancia: float = 0.01) -> list[Sinal]:
    """PC: correção até a MMS21 em tendência; entrada no rompimento do candle que tocou."""
    if len(df) < 6 or not _ok(df["mms21"].iloc[-1], df["mms21"].iloc[-5]):
        return []
    b, ant = df.iloc[-1], df.iloc[-2]
    m21 = b["mms21"]
    subindo = m21 > df["mms21"].iloc[-5]
    if subindo and b["close"] >= m21 and b["low"] <= m21 * (1 + tolerancia):
        return [Sinal("PC de compra (MMS21)", "compra", b["high"] + TICK, ant["low"])]
    if not subindo and b["close"] <= m21 and b["high"] >= m21 * (1 - tolerancia):
        return [Sinal("PC de venda (MMS21)", "venda", b["low"] - TICK, ant["high"])]
    return []


def setups_9(df: pd.DataFrame) -> list[Sinal]:
    """Setups 9.1 a 9.4 sobre a MME9."""
    if len(df) < 5 or not _ok(*df["mme9"].iloc[-5:]):
        return []
    m = df["mme9"].iloc[-5:].to_numpy()
    c = df["close"].to_numpy()
    lo = df["low"].to_numpy()
    hi = df["high"].to_numpy()
    b = df.iloc[-1]
    out = []

    # 9.1: MME9 vinha caindo (2+ candles) e virou para cima no último candle (e vice-versa).
    if m[-1] > m[-2] and m[-2] < m[-3] < m[-4]:
        out.append(Sinal("Setup 9.1 de compra", "compra", b["high"] + TICK, b["low"]))
    if m[-1] < m[-2] and m[-2] > m[-3] > m[-4]:
        out.append(Sinal("Setup 9.1 de venda", "venda", b["low"] - TICK, b["high"]))

    # 9.4: MME9 virou contra por um candle só e já desvirou.
    if m[-1] > m[-2] and m[-2] < m[-3] and m[-3] > m[-4] and b["close"] > b["open"]:
        out.append(Sinal("Setup 9.4 de compra", "compra", b["high"] + TICK, b["low"]))
    if m[-1] < m[-2] and m[-2] > m[-3] and m[-3] < m[-4] and b["close"] < b["open"]:
        out.append(Sinal("Setup 9.4 de venda", "venda", b["low"] - TICK, b["high"]))

    # 9.3: MME9 subindo e 2 candles seguidos fechando abaixo do fechamento do candle de referência.
    if m[-1] > m[-2] > m[-3] and c[-1] < c[-3] and c[-2] < c[-3]:
        out.append(Sinal("Setup 9.3 de compra", "compra", b["high"] + TICK, b["low"]))
    elif m[-1] > m[-2] and c[-1] < lo[-2]:  # 9.2
        out.append(Sinal("Setup 9.2 de compra", "compra", b["high"] + TICK, b["low"]))
    if m[-1] < m[-2] < m[-3] and c[-1] > c[-3] and c[-2] > c[-3]:
        out.append(Sinal("Setup 9.3 de venda", "venda", b["low"] - TICK, b["high"]))
    elif m[-1] < m[-2] and c[-1] > hi[-2]:
        out.append(Sinal("Setup 9.2 de venda", "venda", b["low"] - TICK, b["high"]))
    return out


def lateralizado(df: pd.DataFrame, n: int = 20, faixa_max: float = 0.08, cruzamentos_min: int = 4) -> bool:
    """Canal lateral/congestão: faixa estreita e preço cruzando a MMS21 várias vezes."""
    if len(df) < n or not _ok(*df["mms21"].iloc[-n:]):
        return False
    janela = df.iloc[-n:]
    faixa = (janela["high"].max() - janela["low"].min()) / janela["close"].mean()
    lado = np.sign(janela["close"] - janela["mms21"])
    cruzamentos = int((lado.diff().fillna(0) != 0).sum())
    return faixa <= faixa_max and cruzamentos >= cruzamentos_min


def todos(df: pd.DataFrame) -> list[Sinal]:
    """Checklist obrigatório: todos os setups são testados, sempre."""
    return padroes_candle(df) + agulhada(df) + fffd(df) + ponto_continuo(df) + setups_9(df)
