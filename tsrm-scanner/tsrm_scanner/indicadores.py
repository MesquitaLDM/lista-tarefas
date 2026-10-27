"""Indicadores na configuração oficial TSRM.

Todas as funções recebem/retornam pandas.Series indexadas como o DataFrame de candles
(colunas: open, high, low, close e opcionalmente volume).
"""
import numpy as np
import pandas as pd


def mms(s: pd.Series, n: int) -> pd.Series:
    return s.rolling(n, min_periods=n).mean()


def mme(s: pd.Series, n: int, min_periodos: int | None = None) -> pd.Series:
    return s.ewm(span=n, adjust=False, min_periods=min_periodos or n).mean()


def ifr(close: pd.Series, n: int = 9) -> pd.Series:
    """IFR "Clássico" do Profit: médias simples de ganhos e perdas."""
    delta = close.diff()
    ganho = delta.clip(lower=0).rolling(n, min_periods=n).mean()
    perda = (-delta.clip(upper=0)).rolling(n, min_periods=n).mean()
    rs = ganho / perda.replace(0, np.nan)
    out = 100 - 100 / (1 + rs)
    return out.where(perda != 0, 100.0).where(ganho.notna())


def macd_hist(close: pd.Series, rapida=12, lenta=26, sinal=9) -> pd.Series:
    """Histograma do MACD com média de sinal exponencial."""
    linha = mme(close, rapida) - mme(close, lenta)
    return linha - linha.ewm(span=sinal, adjust=False, min_periods=sinal).mean()


def bollinger(close: pd.Series, n=20, k=2.0):
    media = mms(close, n)
    dp = close.rolling(n, min_periods=n).std(ddof=0)
    return media + k * dp, media, media - k * dp


def obv(close: pd.Series, volume: pd.Series) -> pd.Series:
    direcao = np.sign(close.diff()).fillna(0)
    return (direcao * volume).cumsum()


# Colunas que o motor usa. Se a leitura do Profit já trouxe a coluna (lida da legenda),
# ela é mantida; senão é calculada a partir do OHLC quando há histórico suficiente.
CALCULOS = {
    "mms3": lambda d: mms(d["close"], 3),
    "mme9": lambda d: mme(d["close"], 9),
    "mms21": lambda d: mms(d["close"], 21),
    "mma40": lambda d: mms(d["close"], 40),
    "mma200": lambda d: mms(d["close"], 200),
    "mme400": lambda d: mme(d["close"], 400),
    "ifr": lambda d: ifr(d["close"], 9),
    "macd_hist": lambda d: macd_hist(d["close"]),
    "bb_sup": lambda d: bollinger(d["close"])[0],
    "bb_inf": lambda d: bollinger(d["close"])[2],
    "obv": lambda d: obv(d["close"], d["volume"]) if "volume" in d else pd.Series(np.nan, index=d.index),
}


def completar(df: pd.DataFrame) -> pd.DataFrame:
    """Preenche as colunas de indicadores ausentes (ou com buracos) a partir do OHLC."""
    df = df.copy()
    for col, fn in CALCULOS.items():
        calc = fn(df)
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce").fillna(calc)
        else:
            df[col] = calc
    return df
