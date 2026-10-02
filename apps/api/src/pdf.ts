import PDFDocument from 'pdfkit';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { InvoiceDto } from '../../../packages/core/src/finance';

type Source = { id: string; store_id: string; created_at?: Date | string; body: any };
type Column = { label: string; width: number; align?: 'left' | 'right' };
type Detail = { label: string; value: string };
const colors = {
  ink: '#20312F',
  muted: '#66736F',
  accent: '#226453',
  line: '#DCE4E0',
  wash: '#F1F6F3',
  white: '#FFFFFF',
};
const margin = 44,
  width = 507.28,
  bottom = 770;
const yen = (value: string | bigint) => `${BigInt(value).toLocaleString('ja-JP')} 円`;
const rate = (basisPoints: number) => `${basisPoints / 100}%`;
const payment = (method: string) =>
  ({ cash: '現金', card: 'カード（外部端末）', qr: 'QR（外部端末）' })[method] ?? '記録なし';
function date(value: unknown) {
  if (!value) return '記録なし';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value))
    return value.replaceAll('-', '/');
  const instant = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(instant.getTime())) return '記録なし';
  return (
    new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(instant) + ' JST'
  );
}

function content(kind: string, source: Source) {
  const purchase = kind === 'purchase-order',
    refund = kind === 'refund';
  if (!['sale', 'refund', 'purchase-order'].includes(kind)) throw new Error('未対応の帳票種別です');
  if (purchase && !source.body.issuedSnapshot)
    throw new Error('発行済み発注書の保存内容がありません');
  const body = purchase ? source.body.issuedSnapshot : source.body,
    profile = body.receipt ?? {},
    registered = profile.registered === true;
  const title = purchase
    ? '発注書'
    : refund
      ? '返還伝票'
      : registered && profile.buyerRequired
        ? '適格請求書'
        : '領収書';
  const subtitle = purchase
    ? 'PURCHASE ORDER'
    : refund
      ? 'REFUND STATEMENT'
      : registered
        ? profile.buyerRequired
          ? 'TAX INVOICE'
          : '適格簡易領収書'
        : '非登録事業者';
  const details: Detail[] = [
    {
      label: purchase ? '発行日' : refund ? '返還日' : '取引日',
      value: date(
        purchase
          ? body.issuedAt
          : refund
            ? body.refundedAt
            : (body.occurredAt ?? source.created_at),
      ),
    },
  ];
  if (purchase) details.push({ label: '入荷予定日', value: date(body.expectedAt) });
  if (refund) details.push({ label: '元販売日', value: date(body.originalSaleDate) });
  const issuer = [
    profile.sellerName || '発行者名の記録なし',
    profile.storeName,
    profile.address,
    registered && profile.registrationNumber ? `登録番号  ${profile.registrationNumber}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const recipient = purchase
    ? `${body.supplier ?? '仕入先の記録なし'} 御中`
    : body.buyerName
      ? `${body.buyerName} 様`
      : '宛名の指定なし';
  const columns: Column[] = purchase
    ? [
        { label: 'No.', width: 28 },
        { label: '品名', width: 235 },
        { label: '数量', width: 48, align: 'right' },
        { label: '仕入単価', width: 98, align: 'right' },
        { label: '発注金額', width: 98.28, align: 'right' },
      ]
    : [
        { label: 'No.', width: 28 },
        { label: '品名 / 内訳', width: 235 },
        { label: '数量', width: 42, align: 'right' },
        { label: '適用税率', width: 62, align: 'right' },
        { label: refund ? '税込返金額' : '税込金額', width: 140.28, align: 'right' },
      ];
  const lines: string[][] = body.lines.map((line: any, index: number) => {
    const target = (line as { reducedTarget?: unknown }).reducedTarget === true;
    const descriptions = [
      (target && !purchase ? '※ ' : '') + (line.name ?? line.productId ?? '商品名の記録なし'),
    ];
    if (!purchase && !refund) {
      if (line.taxContext === 'dine-in') descriptions.push('店内飲食');
      if (line.taxContext === 'takeaway') descriptions.push('持ち帰り');
      if (line.price !== undefined)
        descriptions.push(
          `単価 ${yen(line.price)}${body.mode === 'exclusive' ? '（税抜）' : body.mode === 'inclusive' ? '（税込）' : ''}`,
        );
      const discount = BigInt(line.discount ?? '0') + BigInt(line.allocatedDiscount ?? '0');
      if (discount > 0n) descriptions.push(`値引き ${yen(discount)}（会計値引き配分を含む）`);
    }
    if (purchase)
      return [
        String(index + 1),
        descriptions.join('\n'),
        String(line.quantity),
        yen(line.unitCost),
        yen(BigInt(line.unitCost) * BigInt(line.quantity)),
      ];
    return [
      String(index + 1),
      descriptions.join('\n'),
      String(line.quantity),
      line.rateBps === undefined ? '記録なし' : rate(line.rateBps),
      yen(line.paid),
    ];
  });
  const total = purchase
    ? body.lines.reduce(
        (sum: bigint, line: any) => sum + BigInt(line.unitCost) * BigInt(line.quantity),
        0n,
      )
    : BigInt(body.total);
  const taxes: string[][] = [];
  if (refund) {
    const groups = new Map<number, bigint>();
    for (const line of body.lines)
      groups.set(line.rateBps, (groups.get(line.rateBps) ?? 0n) + BigInt(line.paid));
    for (const [basisPoints, amount] of [...groups].sort(([left], [right]) => left - right))
      taxes.push([rate(basisPoints), yen(amount)]);
  } else if (!purchase) {
    for (const tax of [...(body.taxes ?? [])].sort((left, right) => left.rateBps - right.rateBps))
      taxes.push([rate(tax.rateBps), yen(tax.paid), yen(tax.tax)]);
  }
  const settlement: Detail[] = [];
  if (!purchase) {
    settlement.push({ label: refund ? '返金方法' : 'お支払方法', value: payment(body.method) });
    if (
      !refund &&
      body.method === 'cash' &&
      body.tendered !== null &&
      body.tendered !== undefined
    ) {
      settlement.push(
        { label: 'お預り', value: yen(body.tendered) },
        { label: 'お釣り', value: yen(BigInt(body.tendered) - total) },
      );
    }
    if (body.reference)
      settlement.push({
        label: refund ? '返金確認番号' : '決済確認番号',
        value: String(body.reference),
      });
  }
  const notes = purchase
    ? [
        '上記の内容で発注いたします。',
        '発行時点の明細を表示しています。発行後の改訂・入荷状況は含みません。',
        '発注金額は保存済み仕入単価 × 数量の合計です。税区分・税額は本帳票では確定しません。',
      ]
    : refund
      ? [
          '元取引の保存内容に基づき、返金額と適用税率を表示しています。',
          ...(body.reason ? [`返品理由：${body.reason}`] : []),
          ...(body.saleId ? [`元取引番号：${body.saleId}`] : []),
        ]
      : [
          '上記の金額を領収いたしました。',
          '税込金額は値引き後の確定額です。税額は保存済みの税率別内訳を表示しています。',
        ];
  if (
    !purchase &&
    (body as { lines: { reducedTarget?: unknown }[] }).lines.some(
      (line) => line.reducedTarget === true,
    )
  )
    notes.push('※ は軽減税率対象の明細です。販売時に保存された税区分を表示しています。');
  return {
    title,
    subtitle,
    details,
    issuer,
    recipient,
    columns,
    lines,
    total,
    taxes,
    settlement,
    notes,
    purchase,
    refund,
  };
}

class Layout {
  private cursor = 0;
  private readonly characterWidths = new Map<string, number>();
  constructor(
    private readonly document: PDFKit.PDFDocument,
    private readonly title: string,
    private readonly identifier: string,
  ) {}
  private font(size: number, bold = false) {
    this.document.font(bold ? 'jp-bold' : 'jp').fontSize(size);
  }
  private wrap(value: string, available: number, size: number, bold = false) {
    this.font(size, bold);
    const result: string[] = [];
    for (const paragraph of value.split('\n')) {
      let line = '',
        occupied = 0;
      for (const character of paragraph) {
        const key = `${size}:${bold}:${character}`;
        let measure = this.characterWidths.get(key);
        if (measure === undefined) {
          measure = this.document.widthOfString(character);
          this.characterWidths.set(key, measure);
        }
        if (line && occupied + measure > available) {
          result.push(line);
          line = '';
          occupied = 0;
        }
        line += character;
        occupied += measure;
      }
      result.push(line);
    }
    return result;
  }
  private text(
    value: string,
    left: number,
    top: number,
    available: number,
    size = 9,
    color = colors.ink,
    bold = false,
    align: 'left' | 'right' = 'left',
  ) {
    this.font(size, bold);
    this.document
      .fillColor(color)
      .text(value, left, top, { width: available, lineBreak: false, align });
  }
  private rule(top: number, left = margin, available = width, color = colors.line) {
    this.document
      .strokeColor(color)
      .lineWidth(0.6)
      .moveTo(left, top)
      .lineTo(left + available, top)
      .stroke();
  }
  private newPage() {
    this.document.addPage();
    this.text('REGI', margin, 34, 110, 15, colors.accent, true);
    this.text(this.title, margin + 120, 37, width - 120, 11, colors.ink, true, 'right');
    this.rule(62);
    this.text(`伝票番号  ${this.identifier}`, margin, 70, width, 8, colors.muted);
    this.cursor = 96;
  }
  start(subtitle: string) {
    this.document.addPage();
    this.document.rect(margin, 38, 30, 3).fill(colors.accent);
    this.text('REGI', margin, 52, 100, 20, colors.accent, true);
    this.text(this.title, margin + 115, 45, width - 115, 28, colors.ink, true, 'right');
    this.text(subtitle, margin + 115, 87, width - 115, 9, colors.muted, false, 'right');
    this.rule(113);
    this.cursor = 124;
  }
  private space(height: number) {
    if (this.cursor + height > bottom) this.newPage();
  }
  parties(recipient: string, issuer: string, details: Detail[]) {
    this.text('宛先', margin, this.cursor, 230, 8, colors.muted);
    this.text('発行者', margin + 270, this.cursor, 237, 8, colors.muted);
    this.cursor += 17;
    const left = this.wrap(recipient, 245, 12, true),
      right = this.wrap(issuer, 237, 10),
      lineHeight = 17;
    for (let index = 0; index < Math.max(left.length, right.length); index++) {
      this.space(lineHeight);
      if (left[index]) this.text(left[index], margin, this.cursor, 245, 12, colors.ink, true);
      if (right[index]) this.text(right[index], margin + 270, this.cursor, 237, 10);
      this.cursor += lineHeight;
    }
    this.cursor += 12;
    this.detail({ label: '伝票番号', value: this.identifier });
    for (const detail of details) this.detail(detail);
    this.cursor += 10;
  }
  total(label: string, amount: bigint) {
    this.space(70);
    this.document.rect(margin, this.cursor, width, 56).fill(colors.wash);
    this.document.rect(margin, this.cursor, 3, 56).fill(colors.accent);
    this.text(label, margin + 16, this.cursor + 18, 150, 11, colors.accent, true);
    const value = yen(amount);
    let size = 25;
    this.font(size, true);
    while (this.document.widthOfString(value) > width - 195 && size > 9) {
      size -= 0.5;
      this.font(size, true);
    }
    this.text(value, margin + 175, this.cursor + 12, width - 193, size, colors.ink, true, 'right');
    this.cursor += 70;
  }
  heading(title: string) {
    this.space(52);
    this.text(title, margin, this.cursor, width, 11, colors.ink, true);
    this.cursor += 24;
  }
  table(columns: Column[], rows: string[][]) {
    const padding = 7,
      fontSize = 9,
      lineHeight = 14,
      headerHeight = 27;
    const header = () => {
      this.document.rect(margin, this.cursor, width, headerHeight).fill(colors.wash);
      let left = margin;
      for (const column of columns) {
        this.text(
          column.label,
          left + padding,
          this.cursor + 8,
          column.width - padding * 2,
          8,
          colors.muted,
          true,
          column.align,
        );
        left += column.width;
      }
      this.rule(this.cursor + headerHeight);
      this.cursor += headerHeight;
    };
    this.space(headerHeight + lineHeight + padding * 2);
    header();
    for (const row of rows) {
      const cells = row.map((value, index) =>
        this.wrap(value, columns[index].width - padding * 2, fontSize),
      );
      const count = Math.max(...cells.map((cell) => cell.length));
      let offset = 0;
      if (
        this.cursor + count * lineHeight + padding * 2 > bottom &&
        count * lineHeight + padding * 2 <= bottom - 96 - headerHeight
      ) {
        this.newPage();
        header();
      }
      while (offset < count) {
        if (bottom - this.cursor < lineHeight + padding * 2) {
          this.newPage();
          header();
        }
        const visible = Math.min(
          count - offset,
          Math.floor((bottom - this.cursor - padding * 2) / lineHeight),
        );
        let left = margin;
        for (const [index, column] of columns.entries()) {
          for (let line = 0; line < visible; line++)
            if (cells[index][offset + line])
              this.text(
                cells[index][offset + line],
                left + padding,
                this.cursor + padding + line * lineHeight,
                column.width - padding * 2,
                fontSize,
                colors.ink,
                false,
                column.align,
              );
          left += column.width;
        }
        this.cursor += visible * lineHeight + padding * 2;
        this.rule(this.cursor);
        offset += visible;
      }
    }
    this.cursor += 12;
  }
  detail(detail: Detail) {
    const lines = this.wrap(detail.value, width - 112, 9);
    this.space(20);
    this.text(detail.label, margin, this.cursor, 104, 9, colors.muted);
    for (const line of lines) {
      this.space(16);
      this.text(line, margin + 112, this.cursor, width - 112, 9);
      this.cursor += 16;
    }
    this.cursor += 4;
  }
  note(value: string) {
    for (const line of this.wrap(value, width, 8)) {
      this.space(14);
      this.text(line, margin, this.cursor, width, 8, colors.muted);
      this.cursor += 14;
    }
    this.cursor += 4;
  }
  finish() {
    const range = this.document.bufferedPageRange();
    for (let index = range.start; index < range.start + range.count; index++) {
      this.document.switchToPage(index);
      this.rule(790);
      this.text('REGI  /  保存済み取引データから作成', margin, 802, 380, 7, colors.muted);
      this.text(
        `${index + 1} / ${range.count}`,
        margin + 400,
        801,
        width - 400,
        8,
        colors.muted,
        false,
        'right',
      );
    }
  }
}

export async function renderDocumentPdf(kind: string, source: Source): Promise<Buffer> {
  const model = content(kind, source);
  const font =
    process.env.JAPANESE_FONT ?? '/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc';
  if (!existsSync(font))
    throw new Error('日本語PDFフォントがありません。JAPANESE_FONTを確認してください');
  const bold = join(dirname(font), 'NotoSansCJK-Bold.ttc');
  const document = new PDFDocument({
    size: 'A4',
    margin: 0,
    autoFirstPage: false,
    bufferPages: true,
    info: { Title: `${model.title} ${source.id}`, Author: 'REGI', Creator: 'REGI' },
  });
  const chunks: Buffer[] = [];
  const completed = new Promise<Buffer>((resolve, reject) => {
    document.on('data', (chunk) => chunks.push(chunk));
    document.on('end', () => resolve(Buffer.concat(chunks)));
    document.on('error', reject);
  });
  try {
    document.registerFont('jp', font, 'NotoSansCJKjp-Regular');
    document.registerFont(
      'jp-bold',
      existsSync(bold) ? bold : font,
      existsSync(bold) ? 'NotoSansCJKjp-Bold' : 'NotoSansCJKjp-Regular',
    );
    const layout = new Layout(document, model.title, source.id);
    layout.start(model.subtitle);
    layout.parties(model.recipient, model.issuer, model.details);
    layout.total(
      model.purchase ? '発注金額 合計' : model.refund ? 'ご返金額（税込）' : '領収金額（税込）',
      model.total,
    );
    layout.heading(model.purchase ? '発注明細' : model.refund ? '返品明細' : 'お取引明細');
    layout.table(model.columns, model.lines);
    if (model.taxes.length) {
      layout.heading('税率別内訳');
      const columns: Column[] = model.refund
        ? [
            { label: '元の適用税率', width: 200 },
            { label: '税込返金額', width: 307.28, align: 'right' },
          ]
        : [
            { label: '適用税率', width: 127.28 },
            { label: '対象額（税込）', width: 190, align: 'right' },
            { label: 'うち消費税額', width: 190, align: 'right' },
          ];
      layout.table(columns, model.taxes);
    }
    for (const detail of model.settlement) layout.detail(detail);
    layout.heading('備考');
    for (const note of model.notes) layout.note(note);
    layout.finish();
    document.end();
  } catch (error) {
    document.destroy(error instanceof Error ? error : new Error(String(error)));
  }
  return completed;
}

export async function renderFinanceInvoicePdf(invoice: InvoiceDto): Promise<Buffer> {
  const buyerStatement = invoice.sourceKind === 'buyer-statement';
  const confirmed = invoice.supplierConfirmationStatus === 'confirmed-recorded';
  const title = buyerStatement ? '仕入明細書' : '受領請求の管理用写し';
  const font =
    process.env.JAPANESE_FONT ?? '/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc';
  if (!existsSync(font)) throw new Error('日本語PDFフォントがありません');
  const bold = join(dirname(font), 'NotoSansCJK-Bold.ttc');
  const document = new PDFDocument({
    size: 'A4',
    margin: 0,
    autoFirstPage: false,
    bufferPages: true,
    info: { Title: title + ' ' + invoice.internalReference, Author: 'REGI', Creator: 'REGI' },
  });
  const chunks: Buffer[] = [];
  const completed = new Promise<Buffer>((resolve, reject) => {
    document.on('data', (chunk: Buffer) => chunks.push(chunk));
    document.on('end', () => resolve(Buffer.concat(chunks)));
    document.on('error', reject);
  });
  try {
    document.registerFont('jp', font, 'NotoSansCJKjp-Regular');
    document.registerFont(
      'jp-bold',
      existsSync(bold) ? bold : font,
      existsSync(bold) ? 'NotoSansCJKjp-Bold' : 'NotoSansCJKjp-Regular',
    );
    const content = invoice.content;
    const seller = content.seller;
    const buyer = content.buyer;
    const identity = content.sourceIdentity;
    const original =
      identity?.kind === 'numbered'
        ? identity.invoiceNumber
        : (identity?.sourceReference ?? '原識別の記録なし');
    const party = [
      seller?.name,
      seller?.address,
      seller?.registered ? seller.registrationNumber : '非登録事業者として記録',
    ]
      .filter(Boolean)
      .join('\n');
    const purchasing = [buyer?.name, buyer?.address].filter(Boolean).join('\n');
    const layout = new Layout(document, title, invoice.internalReference);
    layout.start(
      buyerStatement
        ? confirmed
          ? '相手方確認記録あり'
          : '相手方確認待ち'
        : '原書類の記載を保存した管理用出力',
    );
    layout.parties(
      (buyerStatement ? seller?.name : (buyer?.name ?? '宛名の記録なし')) + ' 御中',
      buyerStatement ? purchasing : party,
      [
        { label: '原書類の識別', value: original },
        { label: '原書類日', value: date(content.invoiceDate) },
        { label: '支払期日', value: date(content.dueDate) },
        {
          label: '取引期間',
          value: date(content.transactionFrom) + ' 〜 ' + date(content.transactionTo),
        },
        { label: '訂正版', value: String(invoice.revision) },
        { label: '保存済み状態', value: invoice.state },
      ],
    );
    if (buyerStatement) layout.detail({ label: '相手方名称・住所・登録番号', value: party });
    layout.total(
      '原書類・明細の税込総額',
      BigInt(invoice.balance.originalGross ?? invoice.preview.acceptedGross ?? '0'),
    );
    layout.heading('仕入明細');
    layout.table(
      [
        { label: 'No.', width: 28 },
        { label: '取引日・品名', width: 219.28 },
        { label: '数量', width: 50, align: 'right' },
        { label: '税区分', width: 90 },
        { label: '税込金額', width: 120, align: 'right' },
      ],
      invoice.preview.lines.map((l) => [
        String(l.lineNo),
        date(l.transactionDate) + '\n' + (l.reducedTarget ? '※ ' : '') + l.name,
        String(l.quantity),
        l.taxCategory === 'taxable'
          ? rate(l.rateBps)
          : l.taxCategory === 'non-taxable'
            ? '非課税'
            : '不課税',
        yen(l.gross),
      ]),
    );
    layout.heading('税区分ごとの原金額');
    layout.table(
      [
        { label: '税区分', width: 127.28 },
        { label: '税抜金額', width: 125, align: 'right' },
        { label: '税額', width: 110, align: 'right' },
        { label: '税込金額', width: 145, align: 'right' },
      ],
      invoice.preview.taxGroups.map((g) => {
        const a = g.supplierStated ?? g.computed;
        return [
          g.taxCategory === 'taxable'
            ? rate(g.rateBps)
            : g.taxCategory === 'non-taxable'
              ? '非課税'
              : '不課税',
          yen(a.net),
          yen(a.tax),
          yen(a.gross),
        ];
      }),
    );
    if (invoice.preview.lines.some((l) => l.reducedTarget))
      layout.note('※ は保存された原明細の軽減税率対象です。税率のみから推定していません。');
    if (buyerStatement) {
      layout.heading('相手方確認');
      layout.note(
        confirmed
          ? '確定済み明細に対する相手方確認の証跡を記録しています。'
          : '相手方確認待ち。債務の確定と相手方による確認は別の状態です。',
      );
      for (const c of invoice.confirmations.filter(
        (c) => c.postedSnapshotSha256 === invoice.postedSnapshotSha256,
      )) {
        layout.detail({
          label: '確認者・確認日時',
          value: c.counterpartyName + ' / ' + date(c.confirmedAt),
        });
        layout.detail({ label: '方法・証憑ID', value: c.method + ' / ' + c.evidenceId });
      }
    }
    layout.heading('保存・確認情報');
    layout.detail({ label: '原明細SHA-256', value: invoice.postedSnapshotSha256 ?? '下書き' });
    layout.detail({
      label: '原番号なしの根拠',
      value: identity?.kind === 'unnumbered' ? identity.identificationReason : '番号付き原書類',
    });
    layout.note(content.note);
    layout.note(
      '受領原書類・税区分・確認証跡は別途保存されています。登録番号の確認は形式検査のみです。',
    );
    layout.finish();
    document.end();
  } catch (error: unknown) {
    document.destroy(error instanceof Error ? error : new Error(String(error)));
  }
  return completed;
}
