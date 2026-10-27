"""Interpretação do texto da legenda do gráfico (lido do DOM ou via OCR).

O Profit mostra na legenda os valores do candle sob o cursor, ex.:
    "PETR4  A: 37,50  M: 37,90  M: 37,20  F: 37,80  V: +0,80%"
e, nas linhas dos indicadores, os valores das médias. Os padrões abaixo são o ponto
de partida; ajuste-os no config.yaml (seção `legenda.campos`) usando o comando
`inspecionar`, que mostra o texto exatamente como o programa o enxerga.
"""
import re

NUM = r"[-+]?\d{1,3}(?:\.\d{3})+(?:,\d+)?|[-+]?\d+(?:[,.]\d+)?"
_SUFIXOS = {"k": 1e3, "mil": 1e3, "m": 1e6, "mi": 1e6, "b": 1e9, "bi": 1e9}

# Regex por campo. `{num}` é substituído pelo padrão numérico pt-BR. O 1º grupo é o valor.
CAMPOS_PADRAO = {
    "open": r"\bA(?:b(?:ertura)?)?\s*[:=]?\s*({num})",
    "high": r"\bM(?:[áa]x(?:ima)?)?\s*[:=]?\s*({num})",
    "low": r"\bM(?:[íi]n(?:ima)?)?\s*[:=]?\s*({num})",
    "close": r"\bF(?:ech(?:amento)?)?\s*[:=]?\s*({num})",
    "mms3": r"MM\w*\s*\(?\s*3\b[^\d\n]{0,20}({num})",
    "mme9": r"MM\w*\s*\(?\s*9\b[^\d\n]{0,20}({num})",
    "mms21": r"MM\w*\s*\(?\s*21\b[^\d\n]{0,20}({num})",
    "mma200": r"MM\w*\s*\(?\s*200\b[^\d\n]{0,20}({num})",
    "mme400": r"MM\w*\s*\(?\s*400\b[^\d\n]{0,20}({num})",
}
# A legenda do Profit usa "M" tanto para Máxima quanto para Mínima: quando ambas
# aparecem só como "M", a ordem A → M → M → F decide (ver `extrair`).
OHLC_SEQUENCIAL = r"\bA\s*[:=]?\s*({num})\D{0,6}?\bM\s*[:=]?\s*({num})\D{0,6}?\bM\s*[:=]?\s*({num})\D{0,6}?\bF\s*[:=]?\s*({num})"


def para_float(txt: str) -> float | None:
    """Converte '1.234,56', '37,5', '-0,12', '12,5M' em float."""
    if txt is None:
        return None
    t = txt.strip().replace("−", "-").replace(" ", "")
    m = re.match(rf"^({NUM})\s*([a-zA-Z]*)$", t)
    if not m:
        return None
    n, suf = m.group(1), m.group(2).lower()
    if "," in n:
        n = n.replace(".", "").replace(",", ".")
    elif n.count(".") > 1 or re.search(r"\.\d{3}$", n) and len(n.split(".")[0].lstrip("+-")) <= 3 and suf:
        n = n.replace(".", "")
    try:
        v = float(n)
    except ValueError:
        return None
    return v * _SUFIXOS.get(suf, 1)


def _compilar(padrao: str) -> re.Pattern:
    return re.compile(padrao.replace("{num}", NUM), re.IGNORECASE)


def extrair(texto: str, campos: dict | None = None, ordem: list | None = None) -> dict:
    """Extrai os valores numéricos da legenda.

    - `campos`: {nome: regex}; o 1º grupo de captura é o valor.
    - `ordem`: alternativa posicional — lista de nomes na ordem em que os números
      aparecem no texto (use `null`/None para pular um número).
    """
    texto = texto or ""
    valores: dict = {}
    if ordem:
        nums = [para_float(n) for n in re.findall(NUM, texto)]
        for nome, v in zip(ordem, nums):
            if nome:
                valores[nome] = v
        return valores

    campos = campos or CAMPOS_PADRAO
    seq = _compilar(campos.get("ohlc_sequencial", OHLC_SEQUENCIAL)).search(texto)
    if seq:
        for nome, g in zip(("open", "high", "low", "close"), seq.groups()):
            valores[nome] = para_float(g)
    for nome, padrao in campos.items():
        if nome == "ohlc_sequencial" or nome in valores:
            continue
        m = _compilar(padrao).search(texto)
        if m:
            valores[nome] = para_float(m.group(1))
    return valores


def valido(v: dict) -> bool:
    """Um candle só vale se tiver OHLC coerente."""
    try:
        o, h, l, c = v["open"], v["high"], v["low"], v["close"]
    except KeyError:
        return False
    if None in (o, h, l, c):
        return False
    return l <= min(o, c) + 1e-9 and h >= max(o, c) - 1e-9
