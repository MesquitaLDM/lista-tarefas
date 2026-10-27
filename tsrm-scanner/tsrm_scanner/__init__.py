"""TSRM Scanner — leitura do Profit Web e análise pela metodologia TSRM (RM Trader)."""

__version__ = "0.1.0"

# Ordem hierárquica dos tempos gráficos (peso decrescente).
TIMEFRAMES = ["M", "S", "D", "60", "15"]
NOME_TF = {"M": "Mensal", "S": "Semanal", "D": "Diário", "60": "60min", "15": "15min"}
PESO_TF = {"M": 5, "S": 4, "D": 3, "60": 2, "15": 1}
INTRADAY = {"60", "15"}
