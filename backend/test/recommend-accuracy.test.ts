/**
 * The accuracy contract, as a test.
 *
 * Built around the exact failure the store owner reported: "suggest me a
 * shampoo for dry skin" came back with tablets. The fixture catalogue below
 * is deliberately hostile — hair tablets whose text says "dry hair", a face
 * cream labelled for dry skin, a medicine, a misfiled shampoo — so a type
 * filter that leaks shows up here, not in front of a customer.
 *
 * Offline and deterministic: the chat model's only job is to turn a sentence
 * into the structured request each case spells out. `npm run eval:recommend`
 * checks that half against the real model and catalogue.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { findProducts, typeOnlyNote, type FindRequest } from '../src/recommend/find.js';
import { buildProfile } from '../src/recommend/profile.js';
import { selectTopThree } from '../src/recommend/select.js';
import { checkEligibility } from '../src/recommend/eligibility.js';
import { labelMatches } from '../src/recommend/match.js';
import { containsTerm, expandQuery, keywordScore } from '../src/search/normalize.js';
import { productTypeIssues } from '../src/labeling/sanity.js';
import { decideType } from '../src/labeling/pipeline.js';
import { PRODUCT_TYPES, typesForQuestionnaireAnswer, type ProductType } from '../src/products/types.js';
import { openMemoryDb } from '../src/db/index.js';
import {
  upsertCategories,
  saveCategoryMappings,
  saveCategorySuggestions,
  resolveFromCategories,
  productShelf,
  isMedicineProduct,
  listCategoryMap,
} from '../src/products/category-map.js';
import type { Product } from '../src/types.js';

let nextId = 1000;

interface Spec {
  name: string;
  type: ProductType | null;
  concerns?: string[];
  suits?: string[];
  ingredients?: string[];
  categories?: string[];
  name_ar?: string;
  price?: number;
  brand?: string;
  stock?: Product['stock_status'];
  issues?: string[];
  application?: Product['application'];
}

function make(spec: Spec): Product {
  const id = nextId++;
  const type = spec.type;
  return {
    product_id: id,
    sku: `SKU-${id}`,
    name: spec.name,
    name_ar: spec.name_ar ?? null,
    permalink: `https://example.com/p/${id}`,
    image_url: null,
    short_description: null,
    short_description_ar: null,
    description: null,
    description_ar: null,
    categories: spec.categories ?? [],
    category_paths: spec.categories ?? [],
    woo_category_ids: [],
    tags: [],
    brand: spec.brand ?? `Brand ${id}`,
    price: spec.price ?? 5 + (id % 7),
    regular_price: null,
    sale_price: null,
    currency: 'KWD',
    size: '200 ml',
    stock_status: spec.stock ?? 'instock',
    rating_average: null,
    rating_count: 0,
    how_to_use_source: { en: null, ar: null },
    verification_status: 'verified',
    ai_generated: true,
    ai_confidence: 0.85,
    requires_pharmacist_review: false,
    verified_by_pharmacist: false,
    concern_primary: { en: spec.concerns ?? [], ar: [] },
    concern_secondary: { en: [], ar: [] },
    suitable_types: { en: spec.suits ?? [], ar: [] },
    not_ideal_for: { en: null, ar: null },
    key_ingredients: spec.ingredients ?? [],
    full_ingredients: null,
    texture_finish: { en: `texture ${id}`, ar: null },
    fragrance: 'unspecified',
    fragrance_type: null,
    alcohol: 'unspecified',
    alcohol_type: null,
    how_to_use: { en: null, ar: null },
    routine_step: null,
    routine_time: null,
    age_suitability: 'all',
    age_min: null,
    age_max: null,
    pregnancy_guidance: null,
    warnings: { en: null, ar: null },
    complementary_products: [],
    alternative_products: [],
    source_verification_date: null,
    source_verification_note: null,
    synonyms_en: [],
    synonyms_ar: [],
    product_type: type,
    application: spec.application ?? (type ? PRODUCT_TYPES[type].application : null),
    product_type_source: type ? 'ai' : null,
    label_issues: spec.issues ?? [],
    updated_at: new Date().toISOString(),
  };
}

// --- The hostile catalogue ---------------------------------------------------
const CATALOGUE: Product[] = [
  // Real shampoos
  make({ name: 'Hydra Moisture Shampoo 250ml', type: 'shampoo', concerns: ['dryness', 'dry scalp'], suits: ['dry hair'], categories: ['Hair Care > Shampoo'] }),
  make({ name: 'Anti-Dandruff Shampoo 200ml', type: 'shampoo', concerns: ['dandruff', 'flaky scalp'], suits: ['oily scalp'], ingredients: ['ketoconazole'], categories: ['Hair Care > Shampoo'] }),
  make({ name: 'Gentle Baby Shampoo', type: 'shampoo', concerns: ['gentle cleansing'], suits: ['babies', 'sensitive scalp'], categories: ['Baby'] }),
  make({ name: 'Volume Shampoo for Fine Hair', type: 'shampoo', concerns: ['flat hair'], suits: ['fine hair'], categories: ['Hair Care > Shampoo'] }),
  make({ name: 'Colour Protect Shampoo', type: 'shampoo', concerns: ['colour fading'], suits: ['coloured hair'], categories: ['Hair Care'] }),
  make({ name: 'شامبو مرطب للشعر الجاف', name_ar: 'شامبو مرطب للشعر الجاف', type: 'shampoo', concerns: ['جفاف'], suits: ['شعر جاف'], categories: ['العناية بالشعر'] }),
  // A shampoo misfiled under Face Care — its type still makes it a shampoo.
  make({ name: 'Scalp Relief Shampoo', type: 'shampoo', concerns: ['itchy scalp', 'dryness'], categories: ['Face Care'] }),
  // A shampoo whose type is contested by the sanity check — must be held back.
  make({ name: 'Rosemary Shampoo Bar', type: 'hair_oil', concerns: ['dryness'], issues: ['The name mentions "shampoo" but the product type is "hair_oil".'] }),
  // An out-of-stock dry-scalp shampoo — never a primary choice.
  make({ name: 'Out Of Stock Dry Scalp Shampoo', type: 'shampoo', concerns: ['dry scalp', 'dryness'], stock: 'outofstock' }),

  // The trap: swallowed products whose text says hair / dry.
  make({ name: 'Hair Vitamins 60 Tablets', type: 'supplement_tablet', concerns: ['dry hair', 'hair loss', 'dryness'], categories: ['Hair Care'] }),
  make({ name: 'Biotin 10000mcg Capsules', type: 'supplement_capsule', concerns: ['hair growth', 'dry brittle hair'], categories: ['Hair Care', 'Vitamins'] }),
  make({ name: 'Skin Hydration Gummies', type: 'supplement_gummy', concerns: ['dry skin', 'dryness'], categories: ['Vitamins'] }),
  make({ name: 'Collagen Powder Sachets', type: 'supplement_powder', concerns: ['skin elasticity', 'dry skin'], categories: ['Vitamins'] }),

  // Conditioners / masks / oils
  make({ name: 'Repair Conditioner', type: 'conditioner', concerns: ['damage', 'dryness'], suits: ['dry hair'] }),
  make({ name: 'Deep Nourish Hair Mask', type: 'hair_mask', concerns: ['dryness', 'frizz'], suits: ['curly hair'] }),
  make({ name: 'Argan Hair Oil', type: 'hair_oil', concerns: ['frizz', 'dryness'] }),

  // Face
  make({ name: 'Rich Moisturising Face Cream', type: 'moisturizer', concerns: ['dryness', 'dry skin'], suits: ['dry skin'], ingredients: ['ceramides', 'hyaluronic acid'] }),
  make({ name: 'Oil Control Gel Moisturiser', type: 'moisturizer', concerns: ['oiliness', 'shine'], suits: ['oily skin'] }),
  make({ name: 'Hydrating Cleanser', type: 'cleanser', concerns: ['dryness'], suits: ['dry skin', 'sensitive skin'] }),
  make({ name: 'Salicylic Acid Face Wash', type: 'cleanser', concerns: ['acne', 'blackheads'], suits: ['oily skin'], ingredients: ['salicylic acid'] }),
  make({ name: 'Mineral Sunscreen SPF50 Face', type: 'sunscreen', concerns: ['sun protection'], suits: ['sensitive skin', 'oily skin'] }),
  make({ name: 'Body Sunscreen Lotion SPF30', type: 'body_sunscreen', concerns: ['sun protection'], suits: ['all skin types'] }),
  make({ name: 'Vitamin C Brightening Serum', type: 'serum', concerns: ['pigmentation', 'dullness'], ingredients: ['vitamin c'] }),
  make({ name: 'Niacinamide Blemish Serum', type: 'serum', concerns: ['acne', 'enlarged pores'], suits: ['oily skin'], ingredients: ['niacinamide'] }),

  // Body
  make({ name: 'Shea Body Lotion', type: 'body_lotion', concerns: ['dryness', 'rough skin'], suits: ['dry skin'] }),
  make({ name: 'Fresh 48h Deodorant', type: 'deodorant', concerns: ['odour', 'sweat'] }),

  // Medicines — never recommended
  make({ name: 'AUGMENTIN 1G 14 TAB', type: 'medicine', application: 'oral_ingested', categories: ['Antibiotics'] }),
  make({ name: 'Ketoconazole 2% Medicated Shampoo', type: 'medicine', application: 'hair_scalp', concerns: ['dandruff'], categories: ['Medicines'] }),

  // Makeup / general
  make({ name: 'KORFF Lip Pencil 1.08g', type: 'makeup', concerns: ['lip colour'], categories: ['Makeup'] }),
  make({ name: 'Kids Strawberry Toothpaste', type: 'oral_care', concerns: ['cavity protection'], suits: ['children'] }),
];

const byId = new Map(CATALOGUE.map((p) => [p.product_id, p]));

function picksOf(req: FindRequest) {
  const result = findProducts(req, { catalogue: CATALOGUE });
  const products = (result.selection?.picks ?? []).map((p) => byId.get(p.scored.product.product_id)!);
  return { result, products };
}

interface Case {
  says: string;
  request: FindRequest;
  /** Every returned product must be one of these types. */
  onlyTypes: ProductType[];
  /** At least one of these names must be returned (best need-matches). */
  expectAnyOf?: string[];
  /** None of these may ever be returned. */
  never?: string[];
  status?: string;
}

// Each case is a customer sentence and the request the chat model is told
// (by the find_products tool description) to turn it into.
const CASES: Case[] = [
  {
    says: 'Suggest me a shampoo for dry skin',
    request: { product_types: ['shampoo'], concerns: ['dry scalp', 'dryness'], for_types: ['dry'] },
    onlyTypes: ['shampoo'],
    expectAnyOf: ['Hydra Moisture Shampoo 250ml', 'Scalp Relief Shampoo'],
    never: ['Hair Vitamins 60 Tablets', 'Skin Hydration Gummies', 'Rich Moisturising Face Cream', 'Rosemary Shampoo Bar', 'Out Of Stock Dry Scalp Shampoo', 'Ketoconazole 2% Medicated Shampoo'],
    status: 'matched',
  },
  {
    says: 'I need a shampoo for dandruff',
    request: { product_types: ['shampoo'], concerns: ['dandruff'] },
    onlyTypes: ['shampoo'],
    expectAnyOf: ['Anti-Dandruff Shampoo 200ml'],
    never: ['Ketoconazole 2% Medicated Shampoo'],
    status: 'matched',
  },
  {
    says: 'shampoo for coloured hair',
    request: { product_types: ['shampoo'], for_types: ['coloured'] },
    onlyTypes: ['shampoo'],
    expectAnyOf: ['Colour Protect Shampoo'],
  },
  {
    says: 'a shampoo please',
    request: { product_types: ['shampoo'] },
    onlyTypes: ['shampoo'],
  },
  {
    says: 'shampoo for greasy roots and split ends (nothing labelled for it)',
    request: { product_types: ['shampoo'], concerns: ['split ends'] },
    onlyTypes: ['shampoo'],
    status: 'type_only',
  },
  {
    says: 'ابي شامبو للشعر الجاف',
    request: { product_types: ['shampoo'], concerns: ['جفاف'], for_types: ['جاف'] },
    onlyTypes: ['shampoo'],
    expectAnyOf: ['شامبو مرطب للشعر الجاف', 'Hydra Moisture Shampoo 250ml'],
  },
  {
    says: 'conditioner for dry hair',
    request: { product_types: ['conditioner', 'hair_mask', 'leave_in'], concerns: ['dryness'], for_types: ['dry'] },
    onlyTypes: ['conditioner', 'hair_mask', 'leave_in'],
    expectAnyOf: ['Repair Conditioner', 'Deep Nourish Hair Mask'],
    never: ['Argan Hair Oil', 'Hair Vitamins 60 Tablets'],
  },
  {
    says: 'hair vitamins',
    request: {
      product_types: ['supplement_tablet', 'supplement_capsule', 'supplement_gummy', 'supplement_powder', 'supplement_liquid'],
      concerns: ['hair'],
    },
    onlyTypes: ['supplement_tablet', 'supplement_capsule', 'supplement_gummy', 'supplement_powder', 'supplement_liquid'],
    expectAnyOf: ['Hair Vitamins 60 Tablets', 'Biotin 10000mcg Capsules'],
    never: ['Hydra Moisture Shampoo 250ml'],
  },
  {
    says: 'moisturiser for dry skin',
    request: { product_types: ['moisturizer'], concerns: ['dryness'], for_types: ['dry'] },
    onlyTypes: ['moisturizer'],
    expectAnyOf: ['Rich Moisturising Face Cream'],
    never: ['Skin Hydration Gummies', 'Shea Body Lotion', 'Hydra Moisture Shampoo 250ml'],
  },
  {
    says: 'face moisturiser for oily skin',
    request: { product_types: ['moisturizer'], for_types: ['oily'] },
    onlyTypes: ['moisturizer'],
    expectAnyOf: ['Oil Control Gel Moisturiser'],
  },
  {
    says: 'face wash for acne',
    request: { product_types: ['cleanser'], concerns: ['acne'] },
    onlyTypes: ['cleanser'],
    expectAnyOf: ['Salicylic Acid Face Wash'],
    never: ['Niacinamide Blemish Serum'],
  },
  {
    says: 'sunscreen for my face, oily skin',
    request: { product_types: ['sunscreen'], for_types: ['oily'] },
    onlyTypes: ['sunscreen'],
    never: ['Body Sunscreen Lotion SPF30'],
  },
  {
    says: 'any sunscreen',
    request: { product_types: ['sunscreen', 'body_sunscreen'] },
    onlyTypes: ['sunscreen', 'body_sunscreen'],
  },
  {
    says: 'serum with vitamin c',
    request: { product_types: ['serum'], ingredients_wanted: ['vitamin c'] },
    onlyTypes: ['serum'],
    expectAnyOf: ['Vitamin C Brightening Serum'],
  },
  {
    says: 'body lotion for dry skin',
    request: { product_types: ['body_lotion'], concerns: ['dryness'] },
    onlyTypes: ['body_lotion'],
    expectAnyOf: ['Shea Body Lotion'],
    never: ['Rich Moisturising Face Cream'],
  },
  {
    says: 'deodorant',
    request: { product_types: ['deodorant'] },
    onlyTypes: ['deodorant'],
    expectAnyOf: ['Fresh 48h Deodorant'],
  },
  {
    says: 'lip pencil',
    request: { product_types: ['makeup'], concerns: ['lip colour'] },
    onlyTypes: ['makeup'],
    expectAnyOf: ['KORFF Lip Pencil 1.08g'],
  },
  {
    says: 'toothpaste for my kid',
    request: { product_types: ['oral_care'], for_types: ['children'] },
    onlyTypes: ['oral_care'],
    expectAnyOf: ['Kids Strawberry Toothpaste'],
  },
];

describe('find_products — the accuracy contract', () => {
  for (const c of CASES) {
    test(`"${c.says}" returns only ${c.onlyTypes.join(' / ')}`, () => {
      const { result, products } = picksOf(c.request);
      assert.ok(products.length > 0, `nothing returned (status ${result.status})`);

      for (const p of products) {
        assert.ok(
          p.product_type && c.onlyTypes.includes(p.product_type),
          `"${p.name}" (${p.product_type}) is not a ${c.onlyTypes.join('/')}`,
        );
        assert.equal(p.stock_status === 'outofstock', false, `"${p.name}" is out of stock`);
        assert.equal(p.label_issues.length, 0, `"${p.name}" has an unresolved type conflict`);
      }
      if (c.expectAnyOf) {
        assert.ok(
          products.some((p) => c.expectAnyOf!.includes(p.name)),
          `expected one of ${c.expectAnyOf.join(', ')}; got ${products.map((p) => p.name).join(', ')}`,
        );
      }
      for (const name of c.never ?? []) {
        assert.ok(!products.some((p) => p.name === name), `"${name}" must never be returned here`);
      }
      if (c.status) assert.equal(result.status, c.status);
    });
  }

  test('the best need-match comes first for the reported failing request', () => {
    const { products } = picksOf({ product_types: ['shampoo'], concerns: ['dry scalp', 'dryness'], for_types: ['dry'] });
    assert.equal(products[0]!.name, 'Hydra Moisture Shampoo 250ml');
  });

  test('a medicine is never recommended, even when asked for by type', () => {
    const { result, products } = picksOf({ product_types: ['medicine'], concerns: ['dandruff'] });
    assert.equal(result.status, 'medicine');
    assert.equal(products.length, 0);
  });

  test('no product type → the customer must be asked, nothing is guessed', () => {
    const { result, products } = picksOf({ product_types: [], concerns: ['dryness'] });
    assert.equal(result.status, 'need_type');
    assert.equal(products.length, 0);
  });

  test('a type the store does not stock returns nothing — never a substitute type', () => {
    const { result, products } = picksOf({ product_types: ['hair_colour'] });
    assert.equal(result.status, 'none_of_type');
    assert.equal(products.length, 0);
  });

  test('unknown type keys from the model are ignored, not trusted', () => {
    const { result } = picksOf({ product_types: ['tablets for hair'] });
    assert.equal(result.status, 'need_type');
  });

  test('the same-type fallback says so honestly', () => {
    const note = typeOnlyNote({ product_types: ['shampoo'], concerns: ['split ends'] }, ['shampoo'], 'en');
    assert.match(note, /shampoo/i);
    assert.match(note, /split ends/);
    assert.ok(typeOnlyNote({ product_types: ['shampoo'], concerns: ['جفاف'] }, ['shampoo'], 'ar').includes('شامبو'));
  });

  test('ingredients to avoid are honoured', () => {
    const { products } = picksOf({ product_types: ['cleanser'], ingredients_avoid: ['salicylic acid'] });
    assert.ok(!products.some((p) => p.name === 'Salicylic Acid Face Wash'));
  });
});

describe('questionnaire path — the answered product type is a hard filter', () => {
  test('hair → shampoo never returns tablets, conditioners or oils', () => {
    const profile = buildProfile('hair', { product_type: 'shampoo', scalp_type: 'dry', concern_primary: 'dryness' });
    assert.deepEqual(profile.product_types, ['shampoo']);
    const picks = selectTopThree(profile, { catalogue: CATALOGUE }).picks.map((p) => p.scored.product);
    assert.ok(picks.length > 0);
    for (const p of picks) assert.equal(p.product_type, 'shampoo', `${p.name} is not a shampoo`);
  });

  test('hair with no type answer still never returns a swallowed product', () => {
    const profile = buildProfile('hair', { product_type: 'not_sure', concern_primary: 'dryness' });
    assert.deepEqual(profile.product_types, []);
    const picks = selectTopThree(profile, { catalogue: CATALOGUE }).picks.map((p) => p.scored.product);
    for (const p of picks) assert.notEqual(p.application, 'oral_ingested', `${p.name} is swallowed`);
  });

  test('face → moisturiser maps to moisturizers only', () => {
    const profile = buildProfile('face', { product_type: 'moisturizer', skin_type: 'dry' });
    const picks = selectTopThree(profile, { catalogue: CATALOGUE }).picks.map((p) => p.scored.product);
    assert.ok(picks.length > 0);
    for (const p of picks) assert.equal(p.product_type, 'moisturizer');
  });

  test('vitamins → preferred form narrows to that form', () => {
    assert.deepEqual(typesForQuestionnaireAnswer('vitamins', { preferred_form: 'gummy' }), ['supplement_gummy']);
    assert.deepEqual(typesForQuestionnaireAnswer('vitamins', { preferred_form: 'no_preference' }), []);
  });

  test('an untyped product is never shown when a type was asked for', () => {
    const untyped = make({ name: 'Mystery Shampoo', type: null, concerns: ['dryness'] });
    const profile = buildProfile('hair', { product_type: 'shampoo' });
    assert.ok(checkEligibility(untyped, profile).reasons.includes('type_mismatch'));
  });
});

describe('matching words the way customers use them', () => {
  test('"dryness" matches a product labelled "dry skin"', () => {
    assert.equal(labelMatches(['dry skin'], 'dryness'), true);
    assert.equal(labelMatches(['جفاف'], 'dryness'), true);
    assert.equal(labelMatches(['acne'], 'dryness'), false);
  });

  test('"ha" (hyaluronic acid) no longer matches inside "shampoo"', () => {
    assert.equal(containsTerm('suggest me a shampoo for dry skin', 'ha'), false);
    assert.ok(!expandQuery('suggest me a shampoo for dry skin').concepts.includes('hyaluronic_acid'));
    assert.ok(expandQuery('suggest me a shampoo for dry skin').concepts.includes('shampoo'));
  });

  test('Arabic terms still match with the article or a conjunction attached', () => {
    assert.equal(containsTerm('ابي الشامبو', 'شامبو'), true);
    assert.equal(containsTerm('ابي وشامبو', 'شامبو'), true);
  });

  test('filler words no longer count as keyword matches', () => {
    const q = expandQuery('suggest me something for my skin please');
    assert.equal(keywordScore(q, 'Rich cream for dry skin, suggest for everyone'), keywordScore(q, 'skin'));
  });
});

describe('labelling sanity checks', () => {
  test('a name that says shampoo contradicts a non-shampoo type', () => {
    assert.equal(productTypeIssues('Rosemary Shampoo 250ml', 'hair_oil').length, 1);
    assert.equal(productTypeIssues('Rosemary Shampoo 250ml', 'shampoo').length, 0);
    assert.equal(productTypeIssues('2 in 1 Shampoo & Conditioner', 'shampoo').length, 0);
  });

  test('tablets in the name contradict a topical type', () => {
    assert.equal(productTypeIssues('Hair Vitamins 60 Tablets', 'shampoo').length, 1);
    assert.equal(productTypeIssues('Hair Vitamins 60 Tablets', 'supplement_tablet').length, 0);
    assert.equal(productTypeIssues('Panadol 500mg Tablets', 'medicine').length, 0);
  });

  test('no type at all is itself an issue', () => {
    assert.equal(productTypeIssues('Something', null).length, 1);
  });

  test("an admin's type is never overwritten by a relabel", () => {
    const decided = decideType(
      { name: 'Oddly Named Product', product_type: 'hair_mask', product_type_source: 'admin' },
      { product_type: 'shampoo', application: 'hair_scalp' },
      null,
    );
    assert.equal(decided.product_type, 'hair_mask');
    assert.equal(decided.source, 'admin');
    assert.deepEqual(decided.issues, []);
  });

  test("a category's fixed type beats the model", () => {
    const decided = decideType(
      { name: 'Daily Care 400ml', product_type: null, product_type_source: null },
      { product_type: 'body_wash', application: 'body' },
      'shampoo',
    );
    assert.equal(decided.product_type, 'shampoo');
    assert.equal(decided.source, 'category');
    assert.equal(decided.application, 'hair_scalp');
  });

  test("the model's type is checked against the name", () => {
    const decided = decideType(
      { name: 'Biotin Hair Tablets', product_type: null, product_type_source: null },
      { product_type: 'shampoo', application: 'hair_scalp' },
      null,
    );
    assert.equal(decided.issues.length, 1);
  });
});

describe('WooCommerce category map', () => {
  function setup() {
    const conn = openMemoryDb();
    upsertCategories(
      [
        { id: 1, name: 'Hair Care', path: 'Hair Care' },
        { id: 2, name: 'Hair Mask', parent: 1, path: 'Hair Care > Hair Mask' },
        { id: 3, name: 'La Roche-Posay', path: 'Brands > La Roche-Posay' },
        { id: 4, name: 'Antibiotics', path: 'Medicines > Antibiotics' },
        { id: 5, name: 'Face Care', path: 'Face Care' },
      ],
      conn,
    );
    return conn;
  }

  test('the deepest mapped category wins, brand categories are ignored', () => {
    const conn = setup();
    saveCategoryMappings(
      [
        { woo_category_id: 1, shelf: 'hair' },
        { woo_category_id: 2, shelf: 'hair', fixed_product_type: 'hair_mask' },
        { woo_category_id: 3, shelf: 'none' },
      ],
      'test',
      conn,
    );
    const r = resolveFromCategories([3, 1, 2], conn);
    assert.equal(r.shelf, 'hair');
    assert.equal(r.fixedType, 'hair_mask');
    assert.equal(r.medicine, false);
  });

  test('"Hair Mask" is a hair category once mapped — the old keyword guess said face', () => {
    const conn = setup();
    saveCategoryMappings([{ woo_category_id: 2, shelf: 'hair' }], 'test', conn);
    const shelf = productShelf(
      { product_type: null, woo_category_ids: [2], categories: ['Hair Mask'], tags: [], name: 'Some Mask' },
      { conn },
    );
    assert.equal(shelf, 'hair');
  });

  test('a medicine category marks the product a medicine on any shelf', () => {
    const conn = setup();
    saveCategoryMappings([{ woo_category_id: 4, shelf: 'medicine' }, { woo_category_id: 5, shelf: 'face' }], 't', conn);
    assert.equal(
      isMedicineProduct({ product_type: null, woo_category_ids: [4, 5], categories: [], tags: [], name: 'Cream' }, conn),
      true,
    );
  });

  test("AI suggestions apply until an admin saves the row, then the admin's choice stands", () => {
    const conn = setup();
    saveCategorySuggestions([{ woo_category_id: 5, shelf: 'face', product_type: 'moisturizer' }], conn);
    assert.equal(resolveFromCategories([5], conn).fixedType, 'moisturizer');
    saveCategoryMappings([{ woo_category_id: 5, shelf: 'face', fixed_product_type: null }], 't', conn);
    assert.equal(resolveFromCategories([5], conn).fixedType, null, 'saved with no type = decide per product');
    const row = listCategoryMap(conn).find((r) => r.woo_category_id === 5)!;
    assert.equal(row.confirmed, true);
  });

  test('a re-sync never undoes an admin mapping', () => {
    const conn = setup();
    saveCategoryMappings([{ woo_category_id: 1, shelf: 'hair' }], 't', conn);
    upsertCategories([{ id: 1, name: 'Hair Care (renamed)' }], conn);
    const row = listCategoryMap(conn).find((r) => r.woo_category_id === 1)!;
    assert.equal(row.shelf, 'hair');
    assert.equal(row.name, 'Hair Care (renamed)');
    assert.equal(row.path, 'Hair Care', 'a payload without a path keeps the known one');
  });
});
