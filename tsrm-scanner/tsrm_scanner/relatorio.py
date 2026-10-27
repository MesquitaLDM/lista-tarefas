"""Relatórios PDF + Excel + resumo no terminal (layout do skill TSRM)."""
from datetime import datetime
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import cm
from reportlab.platypus import (HRFlowable, Image, PageBreak, Paragraph, SimpleDocTemplate,
                                Spacer, Table, TableStyle)

from . import NOME_TF, TIMEFRAMES
from .analise import Resultado, _fmt

SECOES = [
    ("COMPRA — SETUPS CONFIRMADOS", ("COMPRA",), "1A7A4A"),
    ("VENDA / SHORT — SETUPS CONFIRMADOS", ("VENDA",), "C0392B"),
    ("COMPRA POTENCIAL — AGUARDAR CONFIRMAÇÃO NOS TFs MENORES", ("COMPRA POTENCIAL",), "E67E22"),
    ("AGUARDAR — ENTRADA CONDICIONAL", ("AGUARDAR",), "D4AC0D"),
]
COLUNAS = ["Ticker", "Rating", "Mensal", "Semanal", "Diário", "60min", "15min",
           "Entrada", "Stop", "Alvos", "R/R", "Observação"]


def _estado_tf(r: Resultado, tf: str) -> str:
    t = r.tfs.get(tf)
    if not t:
        return "n/d"
    mag = {"acima": "mág. piso", "abaixo": "mág. teto", "entre": "entre mág.", "n/d": "mág. n/d"}[t.zona_magicas]
    return f"{t.estado} ({mag})"


def _linha(r: Resultado, estrela="*") -> list:
    obs = "; ".join(r.observacoes[:4])
    return [r.ticker, f"{r.categoria} {estrela * r.estrelas}".strip(),
            *[_estado_tf(r, tf) for tf in TIMEFRAMES],
            r.entrada, _fmt(r.stop), " / ".join(_fmt(a) for a in r.alvos) or "-",
            f"{r.rr:.1f}:1" if r.rr else "-", obs]


# ── Terminal ──────────────────────────────────────────────────────────────────

def imprimir(resultados: list[Resultado]):
    print("\n" + "=" * 100)
    print("TSRM — ATIVOS APROVADOS NOS FILTROS")
    print("=" * 100)
    aprovados = [r for r in resultados if r.aprovado]
    if not aprovados:
        print("Nenhum ativo aprovado nesta varredura.")
    for r in aprovados:
        print(f"\n{r.ticker:7} {r.rating:28} entrada {r.entrada} | stop {_fmt(r.stop)} | "
              f"alvos {' / '.join(_fmt(a) for a in r.alvos) or '-'} | R/R {f'{r.rr:.1f}:1' if r.rr else '-'}")
        for tf in TIMEFRAMES:
            if tf in r.tfs:
                print(f"   {NOME_TF[tf]:8} {r.tfs[tf].resumo()}")
        for o in r.observacoes:
            print(f"   • {o}")
    fq = [r for r in resultados if not r.aprovado]
    if fq:
        print("\nFICAR QUIETO / SEM DADOS: " + ", ".join(f"{r.ticker} ({r.observacoes[-1] if r.observacoes else r.categoria})" for r in fq))


# ── PDF ───────────────────────────────────────────────────────────────────────

def gerar_pdf(resultados: list[Resultado], caminho: Path, capturas: Path | None = None):
    doc = SimpleDocTemplate(str(caminho), pagesize=landscape(A4), leftMargin=1 * cm, rightMargin=1 * cm,
                            topMargin=1 * cm, bottomMargin=1 * cm)
    s_tit = ParagraphStyle("t", fontName="Helvetica-Bold", fontSize=16, alignment=TA_CENTER, spaceAfter=4)
    s_sub = ParagraphStyle("s", fontName="Helvetica", fontSize=9, alignment=TA_CENTER, spaceAfter=8,
                           textColor=colors.HexColor("#555555"))
    s_h2 = ParagraphStyle("h", fontName="Helvetica-Bold", fontSize=11, spaceBefore=10, spaceAfter=4)
    s_cel = ParagraphStyle("c", fontName="Helvetica", fontSize=6.8, leading=8)
    s_txt = ParagraphStyle("x", fontName="Helvetica", fontSize=8, leading=10)

    agora = datetime.now()
    story = [Paragraph("TSRM — RELATÓRIO DE OPORTUNIDADES", s_tit),
             Paragraph(f"{agora:%d/%m/%Y %H:%M} | Profit Web | 5 TFs (Mensal → 15min) + MMs mágicas, IFR, MACD, "
                       f"Bollinger e setups nomeados", s_sub),
             HRFlowable(width="100%", thickness=1.5, color=colors.HexColor("#2c3e50")), Spacer(1, 6)]
    larguras = [1.4, 2.6, 2.1, 2.1, 2.1, 2.1, 2.1, 3.4, 1.3, 2.0, 1.1, 5.4]
    larguras = [w * cm for w in larguras]

    for titulo, cats, cor in SECOES:
        linhas = [r for r in resultados if r.categoria in cats]
        if not linhas:
            continue
        dados = [COLUNAS] + [[Paragraph(str(c), s_cel) for c in _linha(r)] for r in linhas]
        t = Table(dados, colWidths=larguras, repeatRows=1)
        t.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#" + cor)),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"), ("FONTSIZE", (0, 0), (-1, 0), 7),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.HexColor("#f2f2f2"), colors.white]),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#cccccc")),
            ("LEFTPADDING", (0, 0), (-1, -1), 3), ("RIGHTPADDING", (0, 0), (-1, -1), 3),
        ]))
        story += [Paragraph(titulo, s_h2), t, Spacer(1, 6)]

    fq = [r for r in resultados if not r.aprovado]
    if fq:
        dados = [["Ticker", "Motivo"]] + [[r.ticker, Paragraph("; ".join(r.observacoes) or r.categoria, s_cel)] for r in fq]
        t = Table(dados, colWidths=[2 * cm, 25.7 * cm], repeatRows=1)
        t.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#7f8c8d")), ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"), ("FONTSIZE", (0, 0), (-1, -1), 7),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.HexColor("#f2f2f2"), colors.white]),
            ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#cccccc")),
        ]))
        story += [Paragraph("FICAR QUIETO — NÃO OPERAR", s_h2), t]

    # Detalhe por ativo aprovado: anotação dos 5 TFs + gráfico Diário capturado.
    for r in (r for r in resultados if r.aprovado):
        bloco = [PageBreak(), Paragraph(f"{r.ticker} — {r.categoria} {'*' * r.estrelas}", s_tit),
                 Paragraph(f"Entrada: {r.entrada} | Stop: {_fmt(r.stop)} | Alvos: "
                           f"{' / '.join(_fmt(a) for a in r.alvos) or '-'} | R/R: {f'{r.rr:.1f}:1' if r.rr else '-'}", s_sub)]
        for tf in TIMEFRAMES:
            if tf in r.tfs:
                bloco.append(Paragraph(f"<b>{NOME_TF[tf]}:</b> {r.tfs[tf].resumo()}", s_txt))
        bloco.append(Spacer(1, 4))
        for o in r.observacoes:
            bloco.append(Paragraph(f"• {o}", s_txt))
        if capturas:
            imgs = [capturas / f"{r.ticker}_{tf}.png" for tf in ("D", "S")]
            imgs = [Image(str(p), width=13.5 * cm, height=8 * cm, kind="proportional") for p in imgs if p.exists()]
            if imgs:
                bloco += [Spacer(1, 6), Table([imgs])]
        story += bloco
    doc.build(story)
    return caminho


# ── Excel ─────────────────────────────────────────────────────────────────────

def gerar_excel(resultados: list[Resultado], caminho: Path):
    wb = Workbook()
    ws = wb.active
    ws.title = "Oportunidades TSRM"
    fino = Side(style="thin", color="CCCCCC")
    borda = Border(left=fino, right=fino, top=fino, bottom=fino)

    def preencher(h):
        return PatternFill("solid", fgColor=h)

    larguras = [8, 18, 18, 18, 18, 18, 18, 30, 9, 16, 8, 70]
    for i, w in enumerate(larguras, 1):
        ws.column_dimensions[get_column_letter(i)].width = w
    ultima = get_column_letter(len(COLUNAS))
    ws.merge_cells(f"A1:{ultima}1")
    ws["A1"] = f"TSRM — OPORTUNIDADES | {datetime.now():%d/%m/%Y %H:%M}"
    ws["A1"].font = Font(bold=True, size=13, color="FFFFFF", name="Arial")
    ws["A1"].fill = preencher("2C3E50")
    ws["A1"].alignment = Alignment(horizontal="center")
    for col, h in enumerate(COLUNAS, 1):
        c = ws.cell(row=2, column=col, value=h)
        c.font = Font(bold=True, color="FFFFFF", name="Arial", size=9)
        c.fill = preencher("34495E")
        c.border = borda
        c.alignment = Alignment(horizontal="center", vertical="center")

    linha = 3
    secoes = SECOES + [("FICAR QUIETO — NÃO OPERAR", ("FICAR QUIETO", "SEM DADOS"), "7F8C8D")]
    for titulo, cats, cor in secoes:
        itens = [r for r in resultados if r.categoria in cats]
        if not itens:
            continue
        ws.merge_cells(f"A{linha}:{ultima}{linha}")
        c = ws.cell(row=linha, column=1, value=titulo)
        c.font = Font(bold=True, size=9, color="FFFFFF", name="Arial")
        c.fill = preencher(cor)
        linha += 1
        for i, r in enumerate(itens):
            vals = _linha(r, "⭐")
            if not r.aprovado:
                vals[-1] = "; ".join(r.observacoes)
            for col, v in enumerate(vals, 1):
                cel = ws.cell(row=linha, column=col, value=v)
                cel.font = Font(size=8, name="Arial")
                cel.fill = preencher("F2F2F2" if i % 2 == 0 else "FFFFFF")
                cel.border = borda
                cel.alignment = Alignment(wrap_text=True, vertical="center",
                                          horizontal="left" if col == len(COLUNAS) else "center")
            linha += 1
        linha += 1
    ws.freeze_panes = "A3"

    # Aba de anotação completa por ativo e TF (tabela de anotação do skill).
    wd = wb.create_sheet("Detalhe 5 TFs")
    cab = ["Ticker", "Rating", "TF", "F", "MMS3", "MME9", "MMS21", "MMA200", "MMA200 papel", "MME400",
           "MME400 papel", "Zona mágicas", "IFR", "MACD hist", "Estado", "Sinais"]
    wd.append(cab)
    for c in wd[1]:
        c.font = Font(bold=True, color="FFFFFF")
        c.fill = preencher("34495E")
    for r in resultados:
        for tf in TIMEFRAMES:
            t = r.tfs.get(tf)
            if not t:
                continue
            wd.append([r.ticker, r.rating, NOME_TF[tf], t.f, t.mm.get("mms3"), t.mm.get("mme9"), t.mm.get("mms21"),
                       t.mm.get("mma200"), t.magica("mma200"), t.mm.get("mme400"), t.magica("mme400"),
                       t.zona_magicas, t.ifr, t.macd_hist, t.estado, "; ".join(map(str, t.sinais))])
    for i, w in enumerate([8, 22, 9, 9, 9, 9, 9, 9, 12, 9, 12, 12, 7, 10, 8, 60], 1):
        wd.column_dimensions[get_column_letter(i)].width = w
    for row in wd.iter_rows(min_row=2):
        for c in row:
            if isinstance(c.value, float):
                c.number_format = "0.00"
    wd.freeze_panes = "A2"
    wb.save(caminho)
    return caminho
