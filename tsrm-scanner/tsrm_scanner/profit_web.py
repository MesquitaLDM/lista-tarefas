"""Automação do Profit Web via Playwright, conectado ao SEU Chrome já logado (CDP).

O programa nunca recebe sua senha: você faz login normalmente no Chrome aberto pelo
comando `abrir-chrome`, e o Playwright apenas se conecta a ele pela porta de depuração.

Fluxo para cada ativo e tempo gráfico:
  1. executa os passos de `acoes.trocar_ativo` e `acoes.timeframes.<TF>` (config.yaml);
  2. executa `acoes.ir_para_fim` (leva o gráfico até os candles mais recentes);
  3. varre o gráfico da direita para a esquerda com o cursor; a cada mudança da legenda,
     registra um candle (OHLC + médias + indicadores lidos);
  4. descarta o candle em formação (o mais à direita) — TSRM só usa candles fechados.
"""
import time
from pathlib import Path

import pandas as pd

from . import NOME_TF, leitura


class ErroProfit(RuntimeError):
    pass


class ProfitWeb:
    def __init__(self, cfg: dict, pasta_capturas: Path | None = None, verbose: bool = True):
        self.cfg = cfg
        self.pasta_capturas = pasta_capturas
        self.verbose = verbose
        self._pw = None
        self.browser = None
        self.page = None

    # ── Conexão ───────────────────────────────────────────────────────────────
    def __enter__(self):
        self.conectar()
        return self

    def __exit__(self, *exc):
        self.fechar()

    def conectar(self):
        from playwright.sync_api import sync_playwright

        self._pw = sync_playwright().start()
        url = self.cfg.get("cdp_url", "http://127.0.0.1:9222")
        try:
            self.browser = self._pw.chromium.connect_over_cdp(url)
        except Exception as e:  # noqa: BLE001
            raise ErroProfit(
                f"Não consegui conectar ao Chrome em {url}. Abra-o com `python -m tsrm_scanner abrir-chrome` "
                f"e faça login no Profit Web. Detalhe: {e}") from e
        alvo = self.cfg.get("url_contem", "profit")
        paginas = [p for ctx in self.browser.contexts for p in ctx.pages]
        candidatas = [p for p in paginas if alvo.lower() in p.url.lower()]
        if not candidatas:
            raise ErroProfit(f"Nenhuma aba com '{alvo}' na URL. Abas abertas: {[p.url for p in paginas]}")
        self.page = candidatas[0]
        self.page.bring_to_front()
        self._log(f"Conectado à aba: {self.page.url}")

    def fechar(self):
        # Só desconecta: o Chrome do usuário continua aberto.
        if self._pw:
            self._pw.stop()
            self._pw = None

    def _log(self, msg):
        if self.verbose:
            print(msg, flush=True)

    # ── Passos configuráveis ──────────────────────────────────────────────────
    def executar(self, passos: list, **vars):
        """Executa uma lista de passos do config. Tipos suportados:
        clicar (seletor Playwright), clicar_xy [x, y], clicar_grafico (true ou [fx, fy]),
        clicar_direito (seletor), digitar (texto), tecla (nome) + vezes, esperar (segundos),
        esperar_seletor (seletor), rolar (delta y no gráfico).
        """
        pg = self.page
        for passo in passos or []:
            passo = {k: (v.format(**vars) if isinstance(v, str) else v) for k, v in passo.items()}
            if "clicar" in passo:
                pg.locator(passo["clicar"]).first.click(timeout=passo.get("timeout", 5000))
            elif "clicar_direito" in passo:
                pg.locator(passo["clicar_direito"]).first.click(button="right", timeout=passo.get("timeout", 5000))
            elif "clicar_xy" in passo:
                x, y = passo["clicar_xy"]
                pg.mouse.click(x, y)
            elif "clicar_grafico" in passo:
                fx, fy = passo["clicar_grafico"] if isinstance(passo["clicar_grafico"], list) else (0.5, 0.5)
                box = self.caixa_grafico()
                pg.mouse.click(box["x"] + box["width"] * fx, box["y"] + box["height"] * fy)
            elif "digitar" in passo:
                pg.keyboard.type(passo["digitar"], delay=passo.get("atraso_ms", 40))
            elif "tecla" in passo:
                for _ in range(int(passo.get("vezes", 1))):
                    pg.keyboard.press(passo["tecla"])
                    time.sleep(passo.get("intervalo", 0.03))
            elif "rolar" in passo:
                box = self.caixa_grafico()
                pg.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
                pg.mouse.wheel(0, passo["rolar"])
            elif "esperar_seletor" in passo:
                pg.locator(passo["esperar_seletor"]).first.wait_for(timeout=passo.get("timeout", 10000))
            if "esperar" in passo:
                time.sleep(float(passo["esperar"]))

    # ── Leitura ───────────────────────────────────────────────────────────────
    def caixa_grafico(self) -> dict:
        sel = self.cfg["grafico"]["seletor"]
        box = self.page.locator(sel).first.bounding_box()
        if not box:
            raise ErroProfit(f"Gráfico não encontrado com o seletor '{sel}'. Rode `inspecionar`.")
        return box

    def texto_legenda(self) -> str:
        leg = self.cfg["legenda"]
        if leg.get("modo", "dom") == "dom":
            textos = self.page.locator(leg["seletor"]).all_inner_texts()
            return "\n".join(textos)
        return self._ocr_legenda()

    def _ocr_legenda(self) -> str:
        import io

        import pytesseract
        from PIL import Image, ImageOps

        leg = self.cfg["legenda"]
        if leg.get("tesseract_cmd"):
            pytesseract.pytesseract.tesseract_cmd = leg["tesseract_cmd"]
        box = self.caixa_grafico()
        rx, ry, rw, rh = leg["regiao_ocr"]  # relativo ao canto do gráfico, em px
        png = self.page.screenshot(clip={"x": box["x"] + rx, "y": box["y"] + ry, "width": rw, "height": rh})
        img = Image.open(io.BytesIO(png)).convert("L")
        if sum(img.getdata()) / (img.width * img.height) < 128:  # tema escuro
            img = ImageOps.invert(img)
        escala = leg.get("escala_ocr", 3)
        img = img.resize((img.width * escala, img.height * escala))
        return pytesseract.image_to_string(img, lang=leg.get("idioma_ocr", "por"), config="--psm 6")

    def ler_candle_sob_cursor(self) -> tuple[str, dict]:
        txt = self.texto_legenda()
        leg = self.cfg["legenda"]
        return txt, leitura.extrair(txt, leg.get("campos"), leg.get("ordem"))

    def varrer(self, n_candles: int) -> pd.DataFrame:
        """Passa o cursor da direita para a esquerda e coleta até n_candles fechados."""
        g = self.cfg["grafico"]
        box = self.caixa_grafico()
        y = box["y"] + box["height"] * g.get("y_cursor", 0.45)
        x = box["x"] + box["width"] - g.get("margem_direita_px", 70)
        x_min = box["x"] + g.get("margem_esquerda_px", 5)
        passo = g.get("passo_px", 2)
        espera = g.get("espera_hover_s", 0.03)

        linhas, ultimo = [], None
        alvo = n_candles + (1 if g.get("descartar_candle_em_formacao", True) else 0)
        while x >= x_min and len(linhas) < alvo:
            self.page.mouse.move(x, y)
            time.sleep(espera)
            txt, v = self.ler_candle_sob_cursor()
            chave = txt.strip()
            # Cada mudança da legenda com valores diferentes = um candle novo.
            if chave != ultimo and leitura.valido(v) and (not linhas or v != linhas[-1]):
                linhas.append(v)
            ultimo = chave
            x -= passo
        if g.get("descartar_candle_em_formacao", True) and linhas:
            linhas = linhas[1:]
        df = pd.DataFrame(list(reversed(linhas)))  # mais antigo → mais recente
        return df.reset_index(drop=True)

    # ── Alto nível ────────────────────────────────────────────────────────────
    def trocar_ativo(self, ticker: str):
        self.executar(self.cfg["acoes"]["trocar_ativo"], ticker=ticker)

    def trocar_tf(self, tf: str):
        passos = self.cfg["acoes"]["timeframes"].get(tf)
        if passos is None:
            raise ErroProfit(f"Sem passos configurados para o tempo gráfico {tf}")
        self.executar(passos)

    def capturar(self, nome: str) -> Path | None:
        if not self.pasta_capturas:
            return None
        self.pasta_capturas.mkdir(parents=True, exist_ok=True)
        caminho = self.pasta_capturas / f"{nome}.png"
        self.page.locator(self.cfg["grafico"]["seletor"]).first.screenshot(path=str(caminho))
        return caminho

    def ler_ativo(self, ticker: str, tfs: list[str]) -> dict:
        """Retorna {tf: DataFrame de candles fechados} para o ativo."""
        self.trocar_ativo(ticker)
        n_por_tf = self.cfg.get("candles_por_tf", {})
        out = {}
        for tf in tfs:
            try:
                self.trocar_tf(tf)
                self.executar(self.cfg["acoes"].get("ir_para_fim", []))
                df = self.varrer(int(n_por_tf.get(tf, 40)))
                self.capturar(f"{ticker}_{tf}")
                self._log(f"  {ticker} {NOME_TF[tf]}: {len(df)} candles lidos")
                if len(df):
                    out[tf] = df
            except Exception as e:  # noqa: BLE001 — um TF com problema não derruba o ativo
                self._log(f"  {ticker} {NOME_TF[tf]}: falha na leitura ({e})")
        return out


INSPECAO_JS = r"""
() => {
  const num = /\d+[.,]\d+/g;
  const caminho = el => {
    const partes = [];
    while (el && el.nodeType === 1 && partes.length < 6) {
      let p = el.tagName.toLowerCase();
      if (el.id) { partes.unshift(p + '#' + CSS.escape(el.id)); break; }
      const cls = [...el.classList].filter(c => !/\d{3,}/.test(c)).slice(0, 2);
      if (cls.length) p += '.' + cls.map(c => CSS.escape(c)).join('.');
      partes.unshift(p);
      el = el.parentElement;
    }
    return partes.join(' > ');
  };
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (el.tagName === 'CANVAS') { out.push({tipo: 'canvas', seletor: caminho(el), x: r.x, y: r.y, w: r.width, h: r.height}); continue; }
    const txt = (el.innerText || '').trim();
    if (!txt || el.children.length > 12 || txt.length > 400) continue;
    const n = (txt.match(num) || []).length;
    if (n >= 3) out.push({tipo: 'texto', seletor: caminho(el), x: r.x, y: r.y, w: r.width, h: r.height, numeros: n, texto: txt.slice(0, 200)});
  }
  return out;
}
"""


def inspecionar(cfg: dict, pasta: Path):
    """Ajuda a configurar: lista canvases e elementos com números (candidatos à legenda)."""
    pasta.mkdir(parents=True, exist_ok=True)
    with ProfitWeb(cfg) as pw:
        pg = pw.page
        print(f"\nAba: {pg.title()} — {pg.url}")
        pg.screenshot(path=str(pasta / "pagina.png"))
        print(f"Screenshot da página: {pasta / 'pagina.png'}")
        sel = cfg.get("grafico", {}).get("seletor")
        if sel and pg.locator(sel).count():
            box = pw.caixa_grafico()
            pg.mouse.move(box["x"] + box["width"] * 0.6, box["y"] + box["height"] * 0.45)
            time.sleep(0.3)
        itens = pg.evaluate(INSPECAO_JS)
        print("\nCANVAS (o gráfico costuma ser o maior):")
        for i in sorted((i for i in itens if i["tipo"] == "canvas"), key=lambda i: -i["w"] * i["h"])[:6]:
            print(f"  {int(i['w'])}x{int(i['h'])} em ({int(i['x'])},{int(i['y'])})  ->  {i['seletor']}")
        print("\nELEMENTOS DE TEXTO COM NÚMEROS (candidatos à legenda — com o cursor sobre o gráfico):")
        for i in sorted((i for i in itens if i["tipo"] == "texto"), key=lambda i: -i["numeros"])[:25]:
            print(f"  [{i['numeros']} nºs] {i['seletor']}\n      \"{i['texto']}\"")
        if cfg.get("legenda", {}).get("seletor") or cfg.get("legenda", {}).get("modo") == "ocr":
            try:
                txt, v = pw.ler_candle_sob_cursor()
                print(f"\nTEXTO DA LEGENDA COM O CONFIG ATUAL:\n{txt}\n\nVALORES EXTRAÍDOS: {v}")
            except Exception as e:  # noqa: BLE001
                print(f"\nNão consegui ler a legenda com o config atual: {e}")


MAIOR_CANVAS_JS = r"""
() => {
  let melhor = null;
  for (const c of document.querySelectorAll('canvas')) {
    const r = c.getBoundingClientRect();
    if (r.width * r.height > (melhor ? melhor.w * melhor.h : 0)) melhor = {x: r.x, y: r.y, w: r.width, h: r.height};
  }
  return melhor;
}
"""


def testar_interacao(cfg: dict, pasta: Path, ticker: str | None = None) -> bool:
    """Teste sem configuração: conecta, acha o gráfico, passa o cursor e (opcional) troca o ativo.

    Mostra as linhas da página que mudam conforme o cursor anda — é ali que está a legenda.
    """
    pasta.mkdir(parents=True, exist_ok=True)
    ok = True

    def item(passou: bool, msg: str):
        nonlocal ok
        ok &= passou
        print(f"  [{'OK' if passou else 'FALHOU'}] {msg}")

    print("\nTESTE DE INTERAÇÃO COM O PROFIT WEB")
    with ProfitWeb(cfg, verbose=False) as pw:
        pg = pw.page
        item(True, f"conectado à aba: {pg.title()} — {pg.url}")
        pg.screenshot(path=str(pasta / "1_antes.png"))

        box = pg.evaluate(MAIOR_CANVAS_JS)
        if not box or box["w"] < 200:
            item(False, "nenhum gráfico (canvas) encontrado na aba — o gráfico está aberto e visível?")
            return False
        item(True, f"gráfico encontrado: {int(box['w'])}x{int(box['h'])} px em ({int(box['x'])},{int(box['y'])})")

        # Varre o cursor da esquerda para a direita, registrando o texto da página em cada ponto.
        y = box["y"] + box["h"] * 0.45
        textos = []
        for frac in (0.2, 0.35, 0.5, 0.65, 0.8):
            pg.mouse.move(box["x"] + box["w"] * frac, y, steps=15)
            time.sleep(0.4)
            textos.append(pg.evaluate("document.body.innerText").splitlines())
        pg.screenshot(path=str(pasta / "2_cursor_no_grafico.png"))
        base = set(textos[0])
        mudaram = [l for t in textos[1:] for l in t if l not in base and l.strip()]
        mudaram = list(dict.fromkeys(mudaram))
        item(bool(mudaram), "a página reage ao cursor (legenda em texto)" if mudaram else
             "nenhum texto mudou com o cursor — a legenda deve estar desenhada no gráfico (usar modo OCR)")
        if mudaram:
            print("      Linhas que mudaram ao mover o cursor (candidatas à legenda):")
            for l in mudaram[:12]:
                print(f"        {l[:150]}")
            nums = leitura.extrair("\n".join(mudaram))
            if leitura.valido(nums):
                print(f"      OHLC reconhecido automaticamente: A={nums['open']} M={nums['high']} m={nums['low']} F={nums['close']}")

        if ticker:
            antes = pg.evaluate("document.body.innerText")
            pg.mouse.click(box["x"] + box["w"] * 0.5, y)
            pg.keyboard.type(ticker.upper(), delay=80)
            time.sleep(0.8)
            pg.screenshot(path=str(pasta / "3_digitando_ticker.png"))
            pg.keyboard.press("Enter")
            time.sleep(2.5)
            pg.screenshot(path=str(pasta / "4_depois_do_enter.png"))
            depois = pg.evaluate("document.body.innerText")
            trocou = ticker.upper() in depois and (ticker.upper() not in antes or depois != antes)
            item(trocou, f"troca de ativo para {ticker.upper()} digitando sobre o gráfico" if trocou else
                 f"não confirmei a troca para {ticker.upper()} — veja os prints 3 e 4; talvez seja preciso clicar "
                 "no campo de busca do ativo antes (configurar acoes.trocar_ativo)")
    print(f"\nPrints salvos em: {pasta.resolve()}")
    print("RESULTADO: " + ("interação funcionando" if ok else "há itens a ajustar (veja acima)"))
    return ok
