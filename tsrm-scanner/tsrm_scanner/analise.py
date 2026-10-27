"""Motor de análise TSRM: leitura de cada tempo gráfico e classificação final do ativo."""
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from . import INTRADAY, NOME_TF, PESO_TF, TIMEFRAMES
from . import indicadores, setups
from .setups import TICK, Sinal

REVERSAO_BAIXA = {"Estrela cadente", "Engolfo de baixa", "Nuvem negra", "Enforcado"}
REVERSAO_ALTA = {"Martelo", "Engolfo de alta", "Piercing line"}


def _num(v):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return None
    return None if np.isnan(v) else v


def _fmt(v):
    return "n/d" if v is None else f"{v:.2f}".replace(".", ",")


@dataclass
class LeituraTF:
    tf: str
    f: float
    mm: dict                  # mms3, mme9, mms21, mma200, mme400, mma40
    ifr: float | None
    macd_hist: float | None
    macd_subindo: bool | None
    bb_sup: float | None
    bb_inf: float | None
    zona_magicas: str         # acima | entre | abaixo | n/d
    curtas_acima: int
    curtas_abaixo: int
    estado: str               # alta | baixa | misto
    sinais: list = field(default_factory=list)
    lateral: bool = False
    maxima_recente: float | None = None
    minima_recente: float | None = None

    def magica(self, nome):
        v = self.mm.get(nome)
        if v is None:
            return "n/d"
        return "piso" if self.f > v else "teto"

    def resumo(self) -> str:
        mm = self.mm
        return (f"F={_fmt(self.f)} | MMS3={_fmt(mm.get('mms3'))} MME9={_fmt(mm.get('mme9'))} "
                f"MMS21={_fmt(mm.get('mms21'))} | MMA200={_fmt(mm.get('mma200'))}({self.magica('mma200')}) "
                f"MME400={_fmt(mm.get('mme400'))}({self.magica('mme400')}) | IFR={_fmt(self.ifr)} "
                f"MACD={'+' if (self.macd_hist or 0) > 0 else '-' if self.macd_hist is not None else 'n/d'} "
                f"| {self.estado.upper()}")


@dataclass
class Resultado:
    ticker: str
    categoria: str            # COMPRA | COMPRA POTENCIAL | AGUARDAR | VENDA | FICAR QUIETO | SEM DADOS
    estrelas: int = 0
    direcao: str = "neutro"
    entrada: str = "-"
    stop: float | None = None
    alvos: list = field(default_factory=list)
    rr: float | None = None
    observacoes: list = field(default_factory=list)
    tfs: dict = field(default_factory=dict)
    pontuacao: float = 0.0

    @property
    def aprovado(self) -> bool:
        return self.categoria in ("COMPRA", "COMPRA POTENCIAL", "AGUARDAR", "VENDA")

    @property
    def rating(self) -> str:
        return f"{self.categoria} {'⭐' * self.estrelas}".strip()


def ler_tf(tf: str, candles: pd.DataFrame) -> LeituraTF | None:
    """Monta a leitura de um TF a partir dos candles FECHADOS (último = último fechado)."""
    if candles is None or len(candles) == 0:
        return None
    df = indicadores.completar(candles)
    ult = df.iloc[-1]
    f = float(ult["close"])
    mm = {k: _num(ult.get(k)) for k in ("mms3", "mme9", "mms21", "mma40", "mma200", "mme400")}

    curtas = [mm[k] for k in ("mms3", "mme9", "mms21") if mm[k] is not None]
    acima = sum(f > v for v in curtas)
    abaixo = sum(f < v for v in curtas)

    mags = [mm[k] for k in ("mma200", "mme400") if mm[k] is not None]
    if not mags:
        zona = "n/d"
    elif all(f > v for v in mags):
        zona = "acima"
    elif all(f < v for v in mags):
        zona = "abaixo"
    else:
        zona = "entre"

    if tf in INTRADAY and zona != "n/d":
        # Regra 11: no intraday a leitura é feita majoritariamente pelas mágicas.
        estado = {"acima": "alta", "abaixo": "baixa"}.get(zona, "misto")
    elif curtas and acima == len(curtas) and zona in ("acima", "n/d"):
        estado = "alta"
    elif curtas and abaixo == len(curtas) and zona in ("abaixo", "n/d"):
        estado = "baixa"
    else:
        estado = "misto"

    hist = df["macd_hist"].dropna()
    macd = _num(hist.iloc[-1]) if len(hist) else None
    macd_subindo = bool(hist.iloc[-1] > hist.iloc[-2]) if len(hist) >= 2 else None

    janela = df.iloc[-20:]
    sinais = setups.todos(df)
    # Regra 11: no intraday os setups são apenas complemento (marcados como tal).
    if tf in INTRADAY:
        for s in sinais:
            s.detalhe = (s.detalhe + " " if s.detalhe else "") + "(complemento intraday)"

    return LeituraTF(
        tf=tf, f=f, mm=mm, ifr=_num(ult.get("ifr")), macd_hist=macd, macd_subindo=macd_subindo,
        bb_sup=_num(ult.get("bb_sup")), bb_inf=_num(ult.get("bb_inf")),
        zona_magicas=zona, curtas_acima=acima, curtas_abaixo=abaixo, estado=estado,
        sinais=sinais, lateral=setups.lateralizado(df) if tf == "D" else False,
        maxima_recente=float(janela["high"].max()), minima_recente=float(janela["low"].min()),
    )


# ── Classificação ─────────────────────────────────────────────────────────────

@dataclass
class Parametros:
    ifr_mensal_max: float = 78.0
    ifr_mensal_colapso: float = 30.0
    ifr_alta_conviccao: tuple = (50.0, 75.0)
    buffer: float = 0.03           # buffer de confirmação acima/abaixo da MM (R$)
    rr_minimo: float = 2.0
    stop_dist_min: float = 0.01    # stop pelo menos 1% distante da entrada


def classificar(ticker: str, candles_por_tf: dict, p: Parametros | None = None) -> Resultado:
    p = p or Parametros()
    tfs = {tf: ler_tf(tf, candles_por_tf.get(tf)) for tf in TIMEFRAMES}
    tfs = {k: v for k, v in tfs.items() if v is not None}
    if "D" not in tfs or "S" not in tfs:
        return Resultado(ticker, "SEM DADOS", observacoes=["Leitura do Diário/Semanal indisponível"], tfs=tfs)

    obs: list[str] = []
    faltando = [NOME_TF[t] for t in TIMEFRAMES if t not in tfs]
    if faltando:
        obs.append("TFs sem leitura: " + ", ".join(faltando))

    M, S, D = tfs.get("M"), tfs["S"], tfs["D"]
    intradays = [tfs[t] for t in ("60", "15") if t in tfs]
    lidos = list(tfs.values())
    n_alta = sum(t.estado == "alta" for t in lidos)
    n_baixa = sum(t.estado == "baixa" for t in lidos)
    pontuacao = sum(PESO_TF[t.tf] * (1 if t.estado == "alta" else -1 if t.estado == "baixa" else 0) for t in lidos)
    macd_pos = sum((t.macd_hist or 0) > 0 for t in lidos)
    macd_neg = sum((t.macd_hist or 0) < 0 for t in lidos)
    piso_todos = all(t.zona_magicas in ("acima", "n/d") for t in lidos) and any(t.zona_magicas == "acima" for t in lidos)
    teto_todos = all(t.zona_magicas in ("abaixo", "n/d") for t in lidos) and any(t.zona_magicas == "abaixo" for t in lidos)
    ifr_m = M.ifr if M else None

    def fq(motivo):
        return Resultado(ticker, "FICAR QUIETO", observacoes=obs + [motivo], tfs=tfs, pontuacao=pontuacao)

    # ── Filtro inicial (visão panorâmica) ──
    if ifr_m is not None and ifr_m > p.ifr_mensal_max and pontuacao > 0:
        return fq(f"IFR Mensal sobrecomprado ({_fmt(ifr_m)})")
    if ifr_m is not None and ifr_m < p.ifr_mensal_colapso and M.macd_hist is not None and M.macd_hist < 0 \
            and not M.macd_subindo and pontuacao < 0 and n_baixa < 4:
        return fq(f"IFR Mensal em colapso ({_fmt(ifr_m)}) com MACD acelerando para baixo")
    if D.lateral:
        return fq("Diário em canal lateral/congestão — sinais de MM tendem a ser falsos")

    maiores_alta = sum(t.estado == "alta" for t in (M, S, D) if t)
    maiores_baixa = sum(t.estado == "baixa" for t in (M, S, D) if t)

    # ── Direção e rating base ──
    direcao, categoria, estrelas = "neutro", None, 0
    recuperacao = False
    if n_alta == len(lidos) == 5 and piso_todos and macd_pos >= 3 \
            and (ifr_m is None or p.ifr_alta_conviccao[0] <= ifr_m <= p.ifr_alta_conviccao[1]):
        direcao, categoria, estrelas = "compra", "COMPRA", 4
    elif n_alta >= 4 and piso_todos:
        direcao, categoria, estrelas = "compra", "COMPRA", 3
    elif n_baixa >= 4 and teto_todos and (macd_neg >= 2):
        direcao, categoria, estrelas = "venda", "VENDA", 3
    elif M and M.zona_magicas == "abaixo" and S.estado == "alta" and D.estado == "alta":
        direcao, categoria, estrelas, recuperacao = "compra", "COMPRA POTENCIAL", 2, True
        obs.append("Recuperação: mágicas do Mensal ainda como teto — alvos limitados abaixo delas")
    elif M and M.zona_magicas == "acima" and S.estado == "baixa" and D.estado == "baixa":
        direcao, categoria, estrelas, recuperacao = "venda", "VENDA", 2, True
        obs.append("Deterioração: mágicas do Mensal ainda como piso — alvos limitados acima delas")
    elif n_alta >= 3 and maiores_alta >= 2:
        direcao, categoria, estrelas = "compra", "COMPRA POTENCIAL", 2
    elif n_baixa >= 3 and maiores_baixa >= 2:
        direcao, categoria, estrelas = "venda", "VENDA", 2
    elif maiores_alta >= 2 and D.estado == "alta":
        direcao, categoria = "compra", "AGUARDAR"
    else:
        return fq("Tendência indefinida entre os tempos gráficos")

    compra = direcao == "compra"
    entrada_cond = None  # (descrição, nível)

    # ── Mágicas intraday atuando contra (AGUARDAR) ──
    for t in intradays:
        contra = [(k, v) for k, v in ((k, t.mm.get(k)) for k in ("mma200", "mme400"))
                  if v is not None and ((compra and v > t.f) or (not compra and v < t.f))]
        if contra:
            nivel = max(v for _, v in contra) if compra else min(v for _, v in contra)
            nomes = "/".join(k.upper() for k, _ in contra)
            papel = "teto" if compra else "piso"
            obs.append(f"{nomes} {NOME_TF[t.tf]} = {_fmt(nivel)} atuando como {papel}")
            if t.tf == "60" or entrada_cond is None:
                lado = "acima" if compra else "abaixo"
                nivel_b = nivel + p.buffer if compra else nivel - p.buffer
                entrada_cond = (f"fechar {NOME_TF[t.tf]} {lado} de {_fmt(nivel)} (+buffer)", nivel_b)
            # Mágica intraday contra o trade: tese dos TFs maiores vale, mas o timing não.
            categoria, estrelas = "AGUARDAR", 0

    # ── MMS21 Semanal como teto (compra) / piso (venda) ──
    m21s = S.mm.get("mms21")
    if m21s is not None and ((compra and S.f < m21s) or (not compra and S.f > m21s)):
        lado, papel = ("acima", "resistência") if compra else ("abaixo", "suporte")
        obs.append(f"MMS21 Semanal {_fmt(m21s)} é {papel} ativa — entrada só após fechar {lado} dela")
        nivel_b = m21s + p.buffer if compra else m21s - p.buffer
        if entrada_cond is None or (compra and nivel_b > entrada_cond[1]) or (not compra and nivel_b < entrada_cond[1]):
            entrada_cond = (f"fechar Semanal {lado} de {_fmt(m21s)}", nivel_b)
        estrelas = min(estrelas, 2)

    # ── Confluência de price action / setups nos TFs maiores ──
    maiores = [t for t in (M, S, D) if t]
    favor = [s for t in maiores for s in t.sinais if s.direcao == direcao]
    contra_pa = [s for s in D.sinais if s.nome in (REVERSAO_BAIXA if compra else REVERSAO_ALTA)]
    if contra_pa and categoria in ("COMPRA", "VENDA", "COMPRA POTENCIAL"):
        obs.append(f"{contra_pa[0].nome} no Diário contra o sinal — rebaixado para AGUARDAR")
        categoria, estrelas = "AGUARDAR", 0
    elif len(favor) >= 2 and categoria in ("COMPRA POTENCIAL", "VENDA") and estrelas == 2 and not recuperacao \
            and not any("MMS21 Semanal" in o for o in obs):
        estrelas = 3
        categoria = "COMPRA" if compra else "VENDA"
        obs.append("Confluência de setups elevou o rating")

    # ── Entrada / stop / alvos ──
    gatilhos_d = [s.gatilho for s in D.sinais if s.direcao == direcao and s.gatilho]
    if compra:
        entrada_base = min(gatilhos_d) if gatilhos_d else (D.maxima_recente if D.f >= D.maxima_recente * 0.995 else D.f) + TICK
    else:
        entrada_base = max(gatilhos_d) if gatilhos_d else (D.minima_recente if D.f <= D.minima_recente * 1.005 else D.f) - TICK
    if entrada_cond:
        nivel = max(entrada_base, entrada_cond[1]) if compra else min(entrada_base, entrada_cond[1])
        entrada_txt = f"≥ {_fmt(nivel)} após {entrada_cond[0]}" if compra else f"≤ {_fmt(nivel)} após {entrada_cond[0]}"
    else:
        nivel = entrada_base
        entrada_txt = f"{'≥' if compra else '≤'} {_fmt(nivel)} (rompimento)"

    stop = _calcular_stop(nivel, compra, D, S, p)
    alvos = _calcular_alvos(nivel, compra, tfs, recuperacao)
    if not alvos:
        # Sem resistência/suporte gráfico no caminho (ex.: topo histórico): projeção pela amplitude do Diário.
        amp = D.maxima_recente - D.minima_recente
        sinal = 1 if compra else -1
        alvos = [round(nivel + sinal * amp, 2), round(nivel + sinal * 1.618 * amp, 2)]
        obs.append("Sem nível gráfico no caminho — alvos por projeção da amplitude (20 candles do Diário)")
    rr = None
    if stop is not None and alvos:
        risco = abs(nivel - stop)
        rr = abs(alvos[0] - nivel) / risco if risco > 0 else None
        if rr is not None and rr < p.rr_minimo:
            rr2 = abs(alvos[-1] - nivel) / risco
            if rr2 >= p.rr_minimo:
                obs.append(f"R/R no alvo 1 = {rr:.1f}:1; no alvo final = {rr2:.1f}:1 — considere parcial 30/70")
            elif categoria != "AGUARDAR":
                obs.append(f"R/R {rr:.1f}:1 abaixo do mínimo {p.rr_minimo:.0f}:1 — aguardar melhor ponto")
                categoria, estrelas = "AGUARDAR", 0

    for t in maiores:
        for s in t.sinais:
            obs.append(f"{NOME_TF[t.tf]}: {s}" + (f" ({s.detalhe})" if s.detalhe else ""))
    if ifr_m is not None:
        obs.append(f"IFR Mensal {_fmt(ifr_m)}")

    return Resultado(ticker, categoria, estrelas, direcao, entrada_txt, stop, alvos, rr, obs, tfs, pontuacao)


def _calcular_stop(entrada, compra, D: LeituraTF, S: LeituraTF, p: Parametros):
    cands = [D.mm.get("mms21"), S.mm.get("mms21"), D.minima_recente if compra else D.maxima_recente,
             D.mm.get("mma200"), D.mm.get("mme400")]
    cands = [c for c in cands if c is not None]
    if compra:
        validos = [c for c in cands if c <= entrada * (1 - p.stop_dist_min)]
        return round(max(validos) - TICK, 2) if validos else None
    validos = [c for c in cands if c >= entrada * (1 + p.stop_dist_min)]
    return round(min(validos) + TICK, 2) if validos else None


def _calcular_alvos(entrada, compra, tfs: dict, recuperacao: bool) -> list:
    niveis = []
    for t in tfs.values():
        if t.tf in INTRADAY:
            continue
        niveis += [t.bb_sup if compra else t.bb_inf, t.maxima_recente if compra else t.minima_recente,
                   t.mm.get("mma200"), t.mm.get("mme400"), t.mm.get("mms21")]
    niveis = sorted({round(n, 2) for n in niveis if n is not None})
    if compra:
        acima = [n for n in niveis if n >= entrada * 1.01]
        limite = None
        if recuperacao and tfs.get("M"):
            mags = [v for v in (tfs["M"].mm.get("mma200"), tfs["M"].mm.get("mme400")) if v and v > entrada]
            limite = min(mags) if mags else None
            if limite:
                acima = [n for n in acima if n < limite] or [round(limite - TICK, 2)]
        alvos = acima[:2]
    else:
        abaixo = [n for n in reversed(niveis) if n <= entrada * 0.99]
        if recuperacao and tfs.get("M"):
            mags = [v for v in (tfs["M"].mm.get("mma200"), tfs["M"].mm.get("mme400")) if v and v < entrada]
            limite = max(mags) if mags else None
            if limite:
                abaixo = [n for n in abaixo if n > limite] or [round(limite + TICK, 2)]
        alvos = abaixo[:2]
    if len(alvos) == 1:
        # Projeção pela amplitude do primeiro movimento.
        alvos.append(round(alvos[0] + (alvos[0] - entrada), 2))
    return alvos


def ordenar(resultados: list[Resultado]) -> list[Resultado]:
    ordem = {"COMPRA": 0, "VENDA": 1, "COMPRA POTENCIAL": 2, "AGUARDAR": 3, "FICAR QUIETO": 4, "SEM DADOS": 5}
    return sorted(resultados, key=lambda r: (ordem.get(r.categoria, 9), -r.estrelas, -abs(r.pontuacao), -(r.rr or 0)))
