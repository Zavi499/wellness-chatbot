/**
 * Live accuracy check: real chat model, real catalogue.
 *
 *   npm run eval:recommend            (dev, via tsx)
 *   npm run eval:recommend:prod       (inside the container)
 *
 * The offline test suite proves the engine never returns a wrong type for a
 * given structured request. This checks the other half — that the chat model
 * turns real customer sentences into the RIGHT structured request — and shows
 * what the store's actual catalogue returns for each. It costs one small
 * chat-model call per sentence and changes nothing.
 */
import { openai, models } from '../openai/client.js';
import { MASTER_SYSTEM_PROMPT } from '../chat/prompts/system.js';
import { TOOL_DEFINITIONS } from '../chat/tools.js';
import { findProducts, type FindRequest } from '../recommend/find.js';
import { searchProducts } from '../search/embeddings.js';
import type { ProductType } from '../products/types.js';

interface EvalCase {
  says: string;
  /** The request is right if it asks for at least one of these, and nothing outside `allowed`. */
  expect: ProductType[];
  allowed?: ProductType[];
  /** Expected tool when it isn't find_products. */
  tool?: 'search_products' | 'none';
}

const SUPPLEMENTS: ProductType[] = [
  'supplement_tablet',
  'supplement_capsule',
  'supplement_gummy',
  'supplement_powder',
  'supplement_liquid',
  'supplement_effervescent',
];

const CASES: EvalCase[] = [
  { says: 'Suggest me a shampoo for dry skin', expect: ['shampoo'] },
  { says: 'I need a shampoo for dandruff', expect: ['shampoo'] },
  { says: 'best shampoo for hair fall?', expect: ['shampoo'], allowed: ['shampoo'] },
  { says: 'something to stop my hair falling out', expect: [], tool: 'none' },
  { says: 'conditioner for curly frizzy hair', expect: ['conditioner'], allowed: ['conditioner', 'hair_mask', 'leave_in'] },
  { says: 'hair oil for dry ends', expect: ['hair_oil'] },
  { says: 'hair vitamins', expect: SUPPLEMENTS, allowed: SUPPLEMENTS },
  { says: 'a moisturiser for very dry skin on my face', expect: ['moisturizer'] },
  { says: 'face wash for oily acne prone skin', expect: ['cleanser'] },
  { says: 'sunscreen for sensitive skin', expect: ['sunscreen', 'body_sunscreen'], allowed: ['sunscreen', 'body_sunscreen'] },
  { says: 'vitamin c serum', expect: ['serum'] },
  { says: 'body lotion for eczema-prone dry skin', expect: ['body_lotion'], allowed: ['body_lotion', 'body_treatment'] },
  { says: 'deodorant without aluminium', expect: ['deodorant'] },
  { says: 'eye cream for dark circles', expect: ['eye_care'] },
  { says: 'lip balm for cracked lips', expect: ['lip_care'] },
  { says: 'toothpaste for sensitive teeth', expect: ['oral_care'] },
  { says: 'something for my dry skin', expect: [], tool: 'none' },
  { says: 'Do you have CeraVe?', expect: [], tool: 'search_products' },
  { says: 'ابي شامبو للشعر الجاف', expect: ['shampoo'] },
  { says: 'كريم مرطب للوجه للبشرة الدهنية', expect: ['moisturizer'] },
  { says: 'واقي شمس للوجه', expect: ['sunscreen'] },
  { says: 'فيتامينات للشعر', expect: SUPPLEMENTS, allowed: SUPPLEMENTS },
  { says: 'مزيل عرق', expect: ['deodorant'] },
];

async function main(): Promise<void> {
  const tools = TOOL_DEFINITIONS.filter((t) => ['find_products', 'search_products'].includes(t.function.name));
  let passed = 0;

  for (const c of CASES) {
    const completion = await openai().chat.completions.create({
      model: models.chat(),
      messages: [
        { role: 'system', content: MASTER_SYSTEM_PROMPT },
        { role: 'user', content: c.says },
      ],
      tools,
      tool_choice: 'auto',
    });
    const call = completion.choices[0]?.message?.tool_calls?.[0];
    const tool = call?.function.name ?? 'none';
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call?.function.arguments ?? '{}');
    } catch {
      args = {};
    }

    let ok: boolean;
    let detail: string;

    if (c.tool) {
      // A clarifying question is also fine when a product lookup was expected
      // to be impossible (no product type given).
      ok = tool === c.tool;
      detail = tool === 'none' ? `asks: ${completion.choices[0]?.message?.content ?? ''}` : JSON.stringify(args);
      if (tool === 'search_products') {
        const hits = await searchProducts(String(args.query ?? ''), 3);
        detail += `\n      → ${hits.map((h) => h.product.name).join(' | ') || '(no results)'}`;
      }
    } else if (tool !== 'find_products') {
      ok = false;
      detail = `expected find_products, got ${tool} ${JSON.stringify(args)}`;
    } else {
      const req = args as unknown as FindRequest;
      const types = (req.product_types ?? []) as ProductType[];
      const allowed = c.allowed ?? c.expect;
      ok = types.some((t) => c.expect.includes(t)) && types.every((t) => allowed.includes(t));
      const found = findProducts(req);
      const picks = (found.selection?.picks ?? []).map((p) => `${p.scored.product.name} [${p.scored.product.product_type}]`);
      detail =
        `types=${JSON.stringify(types)} concerns=${JSON.stringify(req.concerns ?? [])} for=${JSON.stringify(req.for_types ?? [])}` +
        `\n      → ${found.status}: ${picks.join(' | ') || '(nothing)'}`;
    }

    if (ok) passed += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  "${c.says}"\n      ${detail}`);
  }

  console.log(`\n${passed}/${CASES.length} understood correctly (model: ${models.chat()}).`);
  process.exit(passed === CASES.length ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
