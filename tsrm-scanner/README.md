# TSRM Scanner — leitura do Profit Web + análise TSRM

Programa que **controla o Profit Web no seu navegador** (troca ativo, troca tempo gráfico,
passa o cursor sobre os candles), **lê os valores da legenda** (A/M/M/F e médias) e aplica a
metodologia **TSRM (RM Trader)** nos 5 tempos gráficos. No fim, gera um **relatório em PDF e
Excel** com os ativos aprovados nos filtros, com entrada, stop, alvos e R/R.

Não usa a DLL paga do Profit: lê apenas o que já aparece na sua tela.

## Como funciona

```
Chrome (você logado no Profit Web)
   ▲  Playwright conectado pela porta de depuração (CDP) — o programa nunca vê sua senha
   │
   ├─ 1. troca o ativo e o tempo gráfico  (passos configuráveis no config.yaml)
   ├─ 2. vai para os candles mais recentes
   ├─ 3. passa o cursor da direita p/ a esquerda; cada mudança da legenda = 1 candle
   │     (lê do texto da página; se a legenda for desenhada no canvas, usa OCR)
   └─ 4. descarta o candle em formação (TSRM usa só candles fechados)
         │
         ▼
Motor TSRM ── Mensal → Semanal → Diário → 60min → 15min
   • F × MMS3 / MME9 / MMS21, mágicas MMA200 / MME400 (piso/teto) em TODOS os TFs
   • IFR(9) clássico, MACD exponencial, Bollinger(20), 9/40
   • Agulhada, FFFD, PC, setups 9.1–9.4, candles de confirmação, canal lateral
   • Filtro inicial (IFR mensal), regra da MMS21 semanal, mágicas intraday = AGUARDAR
   • Regra 11: intraday lido pelas mágicas; setups intraday só como complemento
         │
         ▼
Relatório: PDF (resumo + página por ativo com o gráfico capturado) e Excel (resumo + detalhe dos 5 TFs)
```

Médias e indicadores lidos da legenda são usados como estão. O que não estiver na legenda
é calculado a partir do OHLC lido, quando houver histórico suficiente; senão aparece "n/d".

## Instalação (Windows)

1. Instale o Python 3.11 ou mais novo (python.org — marque "Add Python to PATH").
2. Nesta pasta:
   ```
   pip install -r requirements.txt
   ```
   O Playwright usa o seu Chrome já instalado, então não precisa rodar `playwright install`.
3. Copie `config.exemplo.yaml` para `config.yaml` e preencha `url_profit`.

## Primeira configuração (uma vez só)

Cada versão do Profit Web tem uma estrutura de página diferente, então é preciso dizer ao programa
onde ficam o gráfico, a legenda e os botões de período.

1. **Abra o Chrome de trabalho:**
   ```
   python -m tsrm_scanner abrir-chrome
   ```
   Abre um Chrome separado (perfil próprio em `perfil-chrome/`) com a porta de depuração.
   Faça login no Profit Web e deixe **um gráfico** aberto, com as 5 médias, o Bollinger e,
   se possível, o IFR e o MACD (configuração oficial TSRM, escala linear).

2. **Inspecione a página:**
   ```
   python -m tsrm_scanner inspecionar
   ```
   Mostra os `<canvas>` (o gráfico) e os elementos de texto com números, ou seja, os candidatos
   à legenda. Copie os seletores para `grafico.seletor` e `legenda.seletor` no `config.yaml`.
   Também salva `inspecao/pagina.png`.
   - Se nenhum elemento de texto mostrar os valores A/M/M/F, a legenda é desenhada dentro do
     canvas: use `legenda.modo: ocr` e instale o
     [Tesseract](https://github.com/UB-Mannheim/tesseract/wiki) com o idioma português.

3. **Ajuste os botões de período** em `acoes.timeframes` (ex.: `clicar: 'text="1D"'`) e a
   troca de ativo em `acoes.trocar_ativo`.

4. **Teste a leitura:**
   ```
   python -m tsrm_scanner testar-leitura PETR4 --tf D
   ```
   Confira os últimos candles e as médias com o que aparece na tela. Se algum valor vier
   errado ou vazio, ajuste `legenda.campos` (regex) ou `legenda.ordem` (posicional).

## Uso diário

```
python -m tsrm_scanner analisar                       # usa ativos.txt
python -m tsrm_scanner analisar --ativos PETR4,VALE3  # lista avulsa
python -m tsrm_scanner analisar --tfs M,S,D           # só os TFs maiores (mais rápido)
```

Saída em `relatorios/AAAA-MM-DD_HHMM/`:
- `TSRM_*.pdf`: seções COMPRA / VENDA / COMPRA POTENCIAL / AGUARDAR / FICAR QUIETO, e uma página
  por ativo aprovado com a anotação dos 5 TFs e os gráficos Diário e Semanal capturados;
- `TSRM_*.xlsx`: mesmo resumo, mais a aba "Detalhe 5 TFs" (F, médias, piso/teto, IFR, MACD, sinais);
- `dados/*.csv`: tudo o que foi lido da tela. Para refazer a análise sem ler a tela de novo
  (ex.: depois de mudar parâmetros):
  ```
  python -m tsrm_scanner analisar --fonte csv --dados relatorios/2026-10-27_1830/dados
  ```

Durante a leitura, **não mexa no mouse dentro da janela do Chrome de trabalho**. Você pode usar
outras janelas normalmente.

## Classificação (resumo das regras implementadas)

| Rating | Critério |
|---|---|
| COMPRA ⭐⭐⭐⭐ | 5 TFs em alta, mágicas como piso em todos, MACD+ em 3 ou mais, IFR mensal 50–75 |
| COMPRA ⭐⭐⭐ | 4 ou mais TFs em alta, mágicas como piso em todos |
| COMPRA POTENCIAL ⭐⭐ | 3 TFs em alta (2 ou mais entre os maiores), ou recuperação com mágicas mensais como teto |
| AGUARDAR | Tese positiva nos TFs maiores, mas mágica do 60/15min como teto (entrada condicional ao fechamento acima + buffer), padrão de reversão contra no Diário, ou R/R abaixo de 2:1 |
| VENDA ⭐⭐⭐ / ⭐⭐ | Regras simétricas |
| FICAR QUIETO | IFR mensal acima de 78, colapso (IFR abaixo de 30 com MACD caindo), Diário em canal lateral, ou tendência indefinida |

Também: MMS21 Semanal acima do F faz a entrada ficar condicional ao fechamento acima dela, com
rating máximo ⭐⭐. Confluência de 2 ou mais setups nos TFs maiores pode elevar ⭐⭐ para ⭐⭐⭐.

Os limites ficam em `parametros` no `config.yaml`.

## Limitações conhecidas

- Figuras gráficas (OCO, triângulos, bandeiras, cunhas), LTA/LTB, divergências e Fibonacci/FIBADA
  **não** são detectados automaticamente. O relatório traz o gráfico capturado para você validar
  visualmente.
- MMA200/MME400 no Mensal só existem se o Profit mostrar o valor na legenda (o programa lê
  ~40 candles por TF, pouco para calcular a 200/400 sozinho).
- A análise é uma triagem automática da metodologia, não recomendação de investimento.
  Confirme sempre no gráfico antes de operar.

## Testes

```
pip install pytest
python -m pytest -q
```
