// Game data: items, fluids, recipes, entities, technologies.
// All simulation numbers are integers. Time in seconds here is converted to ticks (60/s) by the sim.
// Fluid amounts in the sim are stored x60 (FLUID_SCALE) so that "N units per second" == N scaled units per tick.

export const TICKS = 60;
export const FLUID_SCALE = 60;
export const MAP_W = 512;
export const MAP_H = 512;
export const ROCKET_PARTS = 20; // vanilla is 50; shortened for phone sessions
export const DX = [0, 1, 0, -1];
export const DY = [-1, 0, 1, 0];

// ---------------------------------------------------------------- resources
// index in the resource layer -> definition
export const RESOURCES = [
  null,
  { name: 'iron-ore', ja: '鉄鉱石', item: 'iron-ore', color: '#5c7a96', map: '#68859e' },
  { name: 'copper-ore', ja: '銅鉱石', item: 'copper-ore', color: '#c4683a', map: '#cc6a3c' },
  { name: 'coal', ja: '石炭', item: 'coal', color: '#232323', map: '#1a1a1a' },
  { name: 'stone', ja: '石', item: 'stone', color: '#b09a6e', map: '#b49c6c' },
  { name: 'crude-oil', ja: '原油', fluid: 'crude-oil', color: '#4a2a5a', map: '#c040d0' },
];
export const RES_INDEX = Object.fromEntries(RESOURCES.filter(Boolean).map((r, i) => [r.name, i + 1]));

// ---------------------------------------------------------------- fluids
export const FLUIDS = {
  water: { ja: '水', color: '#2c6fd6' },
  steam: { ja: '蒸気', color: '#d8d8d8' },
  'crude-oil': { ja: '原油', color: '#3a2140' },
  'petroleum-gas': { ja: '石油ガス', color: '#7a4a9c' },
  'sulfuric-acid': { ja: '硫酸', color: '#d6c43a' },
};

// ---------------------------------------------------------------- items
// group: resource | intermediate | logistics | production | science
const I = (name, ja, group, stack, extra = {}) => ({ name, ja, group, stack, ...extra });
const list = [
  I('wood', '木材', 'resource', 100, { fuel: 2000000 }),
  I('coal', '石炭', 'resource', 50, { fuel: 4000000 }),
  I('stone', '石', 'resource', 50),
  I('iron-ore', '鉄鉱石', 'resource', 50),
  I('copper-ore', '銅鉱石', 'resource', 50),
  I('iron-plate', '鉄板', 'intermediate', 100),
  I('copper-plate', '銅板', 'intermediate', 100),
  I('steel-plate', '鋼材', 'intermediate', 100),
  I('stone-brick', 'レンガ', 'intermediate', 100),
  I('iron-gear-wheel', '歯車', 'intermediate', 100),
  I('copper-cable', '銅線', 'intermediate', 200),
  I('electronic-circuit', '電子回路', 'intermediate', 200),
  I('advanced-circuit', '発展回路', 'intermediate', 200),
  I('processing-unit', '演算回路', 'intermediate', 100),
  I('engine-unit', 'エンジン', 'intermediate', 50),
  I('plastic-bar', 'プラスチック', 'intermediate', 100),
  I('sulfur', '硫黄', 'intermediate', 50),
  I('battery', '電池', 'intermediate', 200),
  I('solid-fuel', '固形燃料', 'intermediate', 50, { fuel: 12000000 }),
  I('rocket-fuel', 'ロケット燃料', 'intermediate', 10, { fuel: 100000000 }),
  I('low-density-structure', '軽量構造材', 'intermediate', 50),
  I('automation-science-pack', '自動化サイエンスパック', 'science', 200),
  I('logistic-science-pack', '物流サイエンスパック', 'science', 200),
  I('chemical-science-pack', '化学サイエンスパック', 'science', 200),
  // placeable
  I('wooden-chest', '木箱', 'logistics', 50, { place: 'wooden-chest' }),
  I('iron-chest', '鉄の箱', 'logistics', 50, { place: 'iron-chest' }),
  I('steel-chest', '鋼の箱', 'logistics', 50, { place: 'steel-chest' }),
  I('transport-belt', 'ベルトコンベア', 'logistics', 100, { place: 'transport-belt' }),
  I('fast-transport-belt', '高速ベルト', 'logistics', 100, { place: 'fast-transport-belt' }),
  I('express-transport-belt', '超高速ベルト', 'logistics', 100, { place: 'express-transport-belt' }),
  I('underground-belt', '地下ベルト', 'logistics', 50, { place: 'underground-belt' }),
  I('fast-underground-belt', '高速地下ベルト', 'logistics', 50, { place: 'fast-underground-belt' }),
  I('express-underground-belt', '超高速地下ベルト', 'logistics', 50, { place: 'express-underground-belt' }),
  I('splitter', '分配器', 'logistics', 50, { place: 'splitter' }),
  I('fast-splitter', '高速分配器', 'logistics', 50, { place: 'fast-splitter' }),
  I('express-splitter', '超高速分配器', 'logistics', 50, { place: 'express-splitter' }),
  I('burner-inserter', '燃料式インサータ', 'logistics', 50, { place: 'burner-inserter' }),
  I('inserter', 'インサータ', 'logistics', 50, { place: 'inserter' }),
  I('long-handed-inserter', 'ロングアームインサータ', 'logistics', 50, { place: 'long-handed-inserter' }),
  I('fast-inserter', '高速インサータ', 'logistics', 50, { place: 'fast-inserter' }),
  I('small-electric-pole', '小型電柱', 'logistics', 50, { place: 'small-electric-pole' }),
  I('medium-electric-pole', '中型電柱', 'logistics', 50, { place: 'medium-electric-pole' }),
  I('big-electric-pole', '大型電柱', 'logistics', 50, { place: 'big-electric-pole' }),
  I('pipe', 'パイプ', 'logistics', 100, { place: 'pipe' }),
  I('pipe-to-ground', '地下パイプ', 'logistics', 50, { place: 'pipe-to-ground' }),
  I('storage-tank', '貯蔵タンク', 'logistics', 50, { place: 'storage-tank' }),
  I('small-lamp', 'ランプ', 'logistics', 50, { place: 'small-lamp' }),
  I('burner-mining-drill', '燃料式採掘機', 'production', 50, { place: 'burner-mining-drill' }),
  I('electric-mining-drill', '電動採掘機', 'production', 50, { place: 'electric-mining-drill' }),
  I('offshore-pump', '汲み上げポンプ', 'production', 20, { place: 'offshore-pump' }),
  I('boiler', 'ボイラー', 'production', 50, { place: 'boiler' }),
  I('steam-engine', '蒸気機関', 'production', 10, { place: 'steam-engine' }),
  I('solar-panel', 'ソーラーパネル', 'production', 50, { place: 'solar-panel' }),
  I('accumulator', '蓄電池', 'production', 50, { place: 'accumulator' }),
  I('stone-furnace', '石の炉', 'production', 50, { place: 'stone-furnace' }),
  I('steel-furnace', '鋼鉄の炉', 'production', 50, { place: 'steel-furnace' }),
  I('electric-furnace', '電気炉', 'production', 50, { place: 'electric-furnace' }),
  I('assembling-machine-1', '組立機1', 'production', 50, { place: 'assembling-machine-1' }),
  I('assembling-machine-2', '組立機2', 'production', 50, { place: 'assembling-machine-2' }),
  I('assembling-machine-3', '組立機3', 'production', 50, { place: 'assembling-machine-3' }),
  I('oil-refinery', '石油精製所', 'production', 10, { place: 'oil-refinery' }),
  I('chemical-plant', '化学プラント', 'production', 10, { place: 'chemical-plant' }),
  I('pumpjack', '原油ポンプ', 'production', 20, { place: 'pumpjack' }),
  I('lab', '研究所', 'production', 10, { place: 'lab' }),
  I('rocket-silo', 'ロケットサイロ', 'production', 1, { place: 'rocket-silo' }),
];
export const ITEMS = Object.fromEntries(list.map((it, i) => [it.name, { ...it, order: i }]));
export const ITEM_LIST = list.map(i => i.name);

// ---------------------------------------------------------------- recipes
// cat: crafting (hand + assembler), crafting-fluid (assembler 2/3 with fluid), smelting, chemistry, oil, rocket
// enabled: available from the start; others are unlocked by technology.
const R = (name, cat, time, ing, res, extra = {}) => ({ name, cat, time, ing, res, ...extra });
const recipeList = [
  // smelting
  R('iron-plate', 'smelting', 3.2, [['iron-ore', 1]], [['iron-plate', 1]], { enabled: true }),
  R('copper-plate', 'smelting', 3.2, [['copper-ore', 1]], [['copper-plate', 1]], { enabled: true }),
  R('stone-brick', 'smelting', 3.2, [['stone', 2]], [['stone-brick', 1]], { enabled: true }),
  R('steel-plate', 'smelting', 16, [['iron-plate', 5]], [['steel-plate', 1]]),
  // intermediates
  R('iron-gear-wheel', 'crafting', 0.5, [['iron-plate', 2]], [['iron-gear-wheel', 1]], { enabled: true }),
  R('copper-cable', 'crafting', 0.5, [['copper-plate', 1]], [['copper-cable', 2]], { enabled: true }),
  R('electronic-circuit', 'crafting', 0.5, [['iron-plate', 1], ['copper-cable', 3]], [['electronic-circuit', 1]], { enabled: true }),
  R('advanced-circuit', 'crafting', 6, [['electronic-circuit', 2], ['plastic-bar', 2], ['copper-cable', 4]], [['advanced-circuit', 1]]),
  R('processing-unit', 'crafting-fluid', 10, [['electronic-circuit', 20], ['advanced-circuit', 2]], [['processing-unit', 1]], { fing: [['sulfuric-acid', 5]] }),
  R('engine-unit', 'crafting', 10, [['steel-plate', 1], ['iron-gear-wheel', 1], ['pipe', 2]], [['engine-unit', 1]], { nohand: true }),
  R('low-density-structure', 'crafting', 15, [['steel-plate', 2], ['copper-plate', 20], ['plastic-bar', 5]], [['low-density-structure', 1]]),
  R('rocket-fuel', 'crafting', 15, [['solid-fuel', 10]], [['rocket-fuel', 1]], { nohand: true }),
  // chemistry
  R('plastic-bar', 'chemistry', 1, [['coal', 1]], [['plastic-bar', 2]], { fing: [['petroleum-gas', 20]] }),
  R('sulfur', 'chemistry', 1, [], [['sulfur', 2]], { fing: [['water', 30], ['petroleum-gas', 30]] }),
  R('sulfuric-acid', 'chemistry', 1, [['sulfur', 5], ['iron-plate', 1]], [], { fing: [['water', 100]], fres: [['sulfuric-acid', 50]] }),
  R('battery', 'chemistry', 4, [['iron-plate', 1], ['copper-plate', 1]], [['battery', 1]], { fing: [['sulfuric-acid', 20]] }),
  R('solid-fuel', 'chemistry', 2, [], [['solid-fuel', 1]], { fing: [['petroleum-gas', 20]] }),
  // oil
  R('basic-oil-processing', 'oil', 5, [], [], { fing: [['crude-oil', 100]], fres: [['petroleum-gas', 45]], ja: '基本原油処理' }),
  // science
  R('automation-science-pack', 'crafting', 5, [['copper-plate', 1], ['iron-gear-wheel', 1]], [['automation-science-pack', 1]], { enabled: true }),
  R('logistic-science-pack', 'crafting', 6, [['inserter', 1], ['transport-belt', 1]], [['logistic-science-pack', 1]]),
  R('chemical-science-pack', 'crafting', 24, [['engine-unit', 2], ['advanced-circuit', 3], ['sulfur', 1]], [['chemical-science-pack', 2]]),
  // logistics
  R('wooden-chest', 'crafting', 0.5, [['wood', 2]], [['wooden-chest', 1]], { enabled: true }),
  R('iron-chest', 'crafting', 0.5, [['iron-plate', 8]], [['iron-chest', 1]], { enabled: true }),
  R('steel-chest', 'crafting', 0.5, [['steel-plate', 8]], [['steel-chest', 1]]),
  R('transport-belt', 'crafting', 0.5, [['iron-plate', 1], ['iron-gear-wheel', 1]], [['transport-belt', 2]], { enabled: true }),
  R('fast-transport-belt', 'crafting', 0.5, [['iron-gear-wheel', 5], ['transport-belt', 1]], [['fast-transport-belt', 1]]),
  R('express-transport-belt', 'crafting', 0.5, [['iron-gear-wheel', 10], ['fast-transport-belt', 1], ['plastic-bar', 2]], [['express-transport-belt', 1]]),
  R('underground-belt', 'crafting', 1, [['iron-plate', 10], ['transport-belt', 5]], [['underground-belt', 2]]),
  R('fast-underground-belt', 'crafting', 2, [['iron-gear-wheel', 40], ['underground-belt', 2]], [['fast-underground-belt', 2]]),
  R('express-underground-belt', 'crafting', 2, [['iron-gear-wheel', 80], ['fast-underground-belt', 2], ['plastic-bar', 10]], [['express-underground-belt', 2]]),
  R('splitter', 'crafting', 1, [['electronic-circuit', 5], ['iron-plate', 5], ['transport-belt', 4]], [['splitter', 1]]),
  R('fast-splitter', 'crafting', 2, [['iron-gear-wheel', 10], ['electronic-circuit', 10], ['splitter', 1]], [['fast-splitter', 1]]),
  R('express-splitter', 'crafting', 2, [['iron-gear-wheel', 10], ['advanced-circuit', 10], ['fast-splitter', 1]], [['express-splitter', 1]]),
  R('burner-inserter', 'crafting', 0.5, [['iron-plate', 1], ['iron-gear-wheel', 1]], [['burner-inserter', 1]], { enabled: true }),
  R('inserter', 'crafting', 0.5, [['electronic-circuit', 1], ['iron-gear-wheel', 1], ['iron-plate', 1]], [['inserter', 1]], { enabled: true }),
  R('long-handed-inserter', 'crafting', 0.5, [['iron-gear-wheel', 1], ['iron-plate', 1], ['inserter', 1]], [['long-handed-inserter', 1]]),
  R('fast-inserter', 'crafting', 0.5, [['electronic-circuit', 2], ['iron-plate', 2], ['inserter', 1]], [['fast-inserter', 1]]),
  R('small-electric-pole', 'crafting', 0.5, [['wood', 1], ['copper-cable', 2]], [['small-electric-pole', 2]], { enabled: true }),
  R('medium-electric-pole', 'crafting', 0.5, [['copper-plate', 2], ['steel-plate', 2], ['iron-plate', 1]], [['medium-electric-pole', 1]]),
  R('big-electric-pole', 'crafting', 0.5, [['copper-plate', 4], ['steel-plate', 5], ['iron-plate', 4]], [['big-electric-pole', 1]]),
  R('pipe', 'crafting', 0.5, [['iron-plate', 1]], [['pipe', 1]], { enabled: true }),
  R('pipe-to-ground', 'crafting', 0.5, [['pipe', 10], ['iron-plate', 5]], [['pipe-to-ground', 2]], { enabled: true }),
  R('storage-tank', 'crafting', 3, [['iron-plate', 20], ['steel-plate', 5]], [['storage-tank', 1]]),
  R('small-lamp', 'crafting', 0.5, [['electronic-circuit', 1], ['copper-cable', 3], ['iron-plate', 1]], [['small-lamp', 1]]),
  // production
  R('burner-mining-drill', 'crafting', 2, [['iron-gear-wheel', 3], ['stone-furnace', 1], ['iron-plate', 3]], [['burner-mining-drill', 1]], { enabled: true }),
  R('electric-mining-drill', 'crafting', 2, [['electronic-circuit', 3], ['iron-gear-wheel', 5], ['iron-plate', 10]], [['electric-mining-drill', 1]], { enabled: true }),
  R('offshore-pump', 'crafting', 0.5, [['electronic-circuit', 2], ['pipe', 1], ['iron-gear-wheel', 1]], [['offshore-pump', 1]], { enabled: true }),
  R('boiler', 'crafting', 0.5, [['stone-furnace', 1], ['pipe', 4]], [['boiler', 1]], { enabled: true }),
  R('steam-engine', 'crafting', 0.5, [['iron-gear-wheel', 8], ['pipe', 5], ['iron-plate', 10]], [['steam-engine', 1]], { enabled: true }),
  R('solar-panel', 'crafting', 10, [['steel-plate', 5], ['electronic-circuit', 15], ['copper-plate', 5]], [['solar-panel', 1]]),
  R('accumulator', 'crafting', 10, [['iron-plate', 2], ['battery', 5]], [['accumulator', 1]]),
  R('stone-furnace', 'crafting', 0.5, [['stone', 5]], [['stone-furnace', 1]], { enabled: true }),
  R('steel-furnace', 'crafting', 3, [['steel-plate', 6], ['stone-brick', 10]], [['steel-furnace', 1]]),
  R('electric-furnace', 'crafting', 5, [['steel-plate', 10], ['advanced-circuit', 5], ['stone-brick', 10]], [['electric-furnace', 1]]),
  R('assembling-machine-1', 'crafting', 0.5, [['electronic-circuit', 3], ['iron-gear-wheel', 5], ['iron-plate', 9]], [['assembling-machine-1', 1]]),
  R('assembling-machine-2', 'crafting', 0.5, [['steel-plate', 2], ['electronic-circuit', 3], ['iron-gear-wheel', 5], ['assembling-machine-1', 1]], [['assembling-machine-2', 1]]),
  R('assembling-machine-3', 'crafting', 0.5, [['assembling-machine-2', 2], ['advanced-circuit', 10], ['steel-plate', 10]], [['assembling-machine-3', 1]]),
  R('oil-refinery', 'crafting', 8, [['steel-plate', 15], ['iron-gear-wheel', 10], ['stone-brick', 10], ['electronic-circuit', 10], ['pipe', 10]], [['oil-refinery', 1]]),
  R('chemical-plant', 'crafting', 5, [['steel-plate', 5], ['iron-gear-wheel', 5], ['electronic-circuit', 5], ['pipe', 5]], [['chemical-plant', 1]]),
  R('pumpjack', 'crafting', 5, [['steel-plate', 5], ['iron-gear-wheel', 10], ['electronic-circuit', 5], ['pipe', 10]], [['pumpjack', 1]]),
  R('lab', 'crafting', 2, [['electronic-circuit', 10], ['iron-gear-wheel', 10], ['transport-belt', 4]], [['lab', 1]], { enabled: true }),
  R('rocket-silo', 'crafting', 30, [['steel-plate', 500], ['processing-unit', 100], ['engine-unit', 100], ['pipe', 100], ['stone-brick', 500]], [['rocket-silo', 1]]),
  R('rocket-part', 'rocket', 3, [['processing-unit', 10], ['low-density-structure', 10], ['rocket-fuel', 10]], [], { ja: 'ロケット部品', hidden: true }),
];
export const RECIPES = Object.fromEntries(recipeList.map((r, i) => [r.name, { ...r, fing: r.fing || [], fres: r.fres || [], order: i }]));
export const RECIPE_LIST = recipeList.map(r => r.name);
export function recipeName(r) {
  const rec = RECIPES[r];
  if (!rec) return r;
  if (rec.ja) return rec.ja;
  if (rec.res.length) return ITEMS[rec.res[0][0]].ja;
  if (rec.fres.length) return FLUIDS[rec.fres[0][0]].ja;
  return r;
}

// ---------------------------------------------------------------- entities
// kind decides the update code. Sizes are for dir 0 (north). Fluid boxes list connections for dir 0:
// {x, y, d} = tile inside the footprint and the outward direction of the connection.
// power: watts. Electric consumers: elec:true. Burner: burner:true.
const belt = (name, ja, tier, speed, item) => ({ name, ja, kind: 'belt', w: 1, h: 1, tier, speed, item, mine: 0.1, hp: 150 });
const ub = (name, ja, tier, speed, reach) => ({ name, ja, kind: 'underground', w: 1, h: 1, tier, speed, reach, mine: 0.1, hp: 150 });
const sp = (name, ja, tier, speed) => ({ name, ja, kind: 'splitter', w: 2, h: 1, tier, speed, mine: 0.1, hp: 170 });
export const ENTITIES = {
  'wooden-chest': { ja: '木箱', kind: 'chest', w: 1, h: 1, slots: 16, hp: 100 },
  'iron-chest': { ja: '鉄の箱', kind: 'chest', w: 1, h: 1, slots: 32, hp: 200 },
  'steel-chest': { ja: '鋼の箱', kind: 'chest', w: 1, h: 1, slots: 48, hp: 350 },
  'transport-belt': belt('transport-belt', 'ベルトコンベア', 0, 8),
  'fast-transport-belt': belt('fast-transport-belt', '高速ベルト', 1, 16),
  'express-transport-belt': belt('express-transport-belt', '超高速ベルト', 2, 24),
  'underground-belt': ub('underground-belt', '地下ベルト', 0, 8, 5),
  'fast-underground-belt': ub('fast-underground-belt', '高速地下ベルト', 1, 16, 7),
  'express-underground-belt': ub('express-underground-belt', '超高速地下ベルト', 2, 24, 9),
  splitter: sp('splitter', '分配器', 0, 8),
  'fast-splitter': sp('fast-splitter', '高速分配器', 1, 16),
  'express-splitter': sp('express-splitter', '超高速分配器', 2, 24),
  // inserters: swing = ticks for a half turn, reach = tiles
  'burner-inserter': { ja: '燃料式インサータ', kind: 'inserter', w: 1, h: 1, swing: 50, reach: 1, burner: true, power: 94200 },
  inserter: { ja: 'インサータ', kind: 'inserter', w: 1, h: 1, swing: 36, reach: 1, elec: true, power: 13200 },
  'long-handed-inserter': { ja: 'ロングアームインサータ', kind: 'inserter', w: 1, h: 1, swing: 25, reach: 2, elec: true, power: 20000 },
  'fast-inserter': { ja: '高速インサータ', kind: 'inserter', w: 1, h: 1, swing: 12, reach: 1, elec: true, power: 46700 },
  // poles: wire = max wire length, supply = supply area half size (area is (2*supply+1) for odd)
  'small-electric-pole': { ja: '小型電柱', kind: 'pole', w: 1, h: 1, wire: 7.5, supply: 2.5 },
  'medium-electric-pole': { ja: '中型電柱', kind: 'pole', w: 1, h: 1, wire: 9, supply: 3.5 },
  'big-electric-pole': { ja: '大型電柱', kind: 'pole', w: 2, h: 2, wire: 30, supply: 2 },
  'small-lamp': { ja: 'ランプ', kind: 'lamp', w: 1, h: 1, elec: true, power: 5000 },
  pipe: { ja: 'パイプ', kind: 'pipe', w: 1, h: 1, fluid: [{ cap: 100, conn: [{ x: 0, y: 0, d: 0 }, { x: 0, y: 0, d: 1 }, { x: 0, y: 0, d: 2 }, { x: 0, y: 0, d: 3 }] }] },
  'pipe-to-ground': { ja: '地下パイプ', kind: 'pipe-to-ground', w: 1, h: 1, reach: 10, fluid: [{ cap: 100, conn: [{ x: 0, y: 0, d: 0 }] }] },
  'storage-tank': { ja: '貯蔵タンク', kind: 'tank', w: 3, h: 3, fluid: [{ cap: 25000, conn: [{ x: 1, y: 0, d: 0 }, { x: 2, y: 1, d: 1 }, { x: 1, y: 2, d: 2 }, { x: 0, y: 1, d: 3 }] }] },
  // mining: speed in 1/1000, area = mining area size (centred), out = output tile (dir 0) relative to top-left
  'burner-mining-drill': { ja: '燃料式採掘機', kind: 'drill', w: 2, h: 2, speed: 250, area: 2, burner: true, power: 150000, out: { x: 0, y: -1 } },
  'electric-mining-drill': { ja: '電動採掘機', kind: 'drill', w: 3, h: 3, speed: 500, area: 5, elec: true, power: 90000, out: { x: 1, y: -1 } },
  'offshore-pump': { ja: '汲み上げポンプ', kind: 'offshore', w: 1, h: 1, rate: 1200, fluid: [{ cap: 100, conn: [{ x: 0, y: 0, d: 0 }], out: true }] },
  boiler: { ja: 'ボイラー', kind: 'boiler', w: 3, h: 2, burner: true, power: 1800000,
    fluid: [{ cap: 200, conn: [{ x: 0, y: 1, d: 3 }, { x: 2, y: 1, d: 1 }], filter: 'water' }, { cap: 200, conn: [{ x: 1, y: 0, d: 0 }], out: true, filter: 'steam' }] },
  'steam-engine': { ja: '蒸気機関', kind: 'engine', w: 3, h: 5, power: 900000, fluid: [{ cap: 200, conn: [{ x: 1, y: 0, d: 0 }, { x: 1, y: 4, d: 2 }], filter: 'steam' }] },
  'solar-panel': { ja: 'ソーラーパネル', kind: 'solar', w: 3, h: 3, power: 60000 },
  accumulator: { ja: '蓄電池', kind: 'accumulator', w: 2, h: 2, power: 300000, cap: 5000000 },
  'stone-furnace': { ja: '石の炉', kind: 'furnace', w: 2, h: 2, speed: 1000, burner: true, power: 90000, cats: ['smelting'] },
  'steel-furnace': { ja: '鋼鉄の炉', kind: 'furnace', w: 2, h: 2, speed: 2000, burner: true, power: 90000, cats: ['smelting'] },
  'electric-furnace': { ja: '電気炉', kind: 'furnace', w: 3, h: 3, speed: 2000, elec: true, power: 180000, cats: ['smelting'] },
  'assembling-machine-1': { ja: '組立機1', kind: 'assembler', w: 3, h: 3, speed: 500, elec: true, power: 75000, cats: ['crafting'] },
  'assembling-machine-2': { ja: '組立機2', kind: 'assembler', w: 3, h: 3, speed: 750, elec: true, power: 150000, cats: ['crafting', 'crafting-fluid'],
    fluid: [{ cap: 1000, conn: [{ x: 1, y: 0, d: 0 }], role: 'in' }] },
  'assembling-machine-3': { ja: '組立機3', kind: 'assembler', w: 3, h: 3, speed: 1250, elec: true, power: 375000, cats: ['crafting', 'crafting-fluid'],
    fluid: [{ cap: 1000, conn: [{ x: 1, y: 0, d: 0 }], role: 'in' }] },
  'oil-refinery': { ja: '石油精製所', kind: 'assembler', w: 5, h: 5, speed: 1000, elec: true, power: 420000, cats: ['oil'],
    fluid: [{ cap: 1000, conn: [{ x: 1, y: 4, d: 2 }], role: 'in' }, { cap: 1000, conn: [{ x: 3, y: 4, d: 2 }], role: 'in' },
      { cap: 1000, conn: [{ x: 4, y: 0, d: 0 }], role: 'out' }, { cap: 1000, conn: [{ x: 2, y: 0, d: 0 }], role: 'out' }] },
  'chemical-plant': { ja: '化学プラント', kind: 'assembler', w: 3, h: 3, speed: 1000, elec: true, power: 210000, cats: ['chemistry'],
    fluid: [{ cap: 1000, conn: [{ x: 0, y: 2, d: 2 }], role: 'in' }, { cap: 1000, conn: [{ x: 2, y: 2, d: 2 }], role: 'in' },
      { cap: 1000, conn: [{ x: 0, y: 0, d: 0 }], role: 'out' }, { cap: 1000, conn: [{ x: 2, y: 0, d: 0 }], role: 'out' }] },
  pumpjack: { ja: '原油ポンプ', kind: 'pumpjack', w: 3, h: 3, elec: true, power: 90000, fluid: [{ cap: 1000, conn: [{ x: 1, y: 0, d: 0 }], out: true }] },
  lab: { ja: '研究所', kind: 'lab', w: 3, h: 3, speed: 1000, elec: true, power: 60000 },
  'rocket-silo': { ja: 'ロケットサイロ', kind: 'silo', w: 9, h: 9, speed: 1000, elec: true, power: 250000, cats: ['rocket'] },
};
for (const [k, v] of Object.entries(ENTITIES)) { v.name = k; if (!v.item) v.item = k; }

// ---------------------------------------------------------------- technologies
// cost: units x packs, time = seconds per unit (lab speed 1)
const RED = ['automation-science-pack'];
const RG = ['automation-science-pack', 'logistic-science-pack'];
const RGB = ['automation-science-pack', 'logistic-science-pack', 'chemical-science-pack'];
const T = (name, ja, packs, units, time, prereq, unlocks, extra = {}) => ({ name, ja, packs, units, time, prereq, unlocks, ...extra });
const techList = [
  T('automation', '自動化', RED, 10, 10, [], ['assembling-machine-1', 'long-handed-inserter']),
  T('logistics', '物流', RED, 20, 15, [], ['underground-belt', 'splitter']),
  T('electronics', '電子工学', RED, 30, 15, ['automation'], []),
  T('fast-inserter', '高速インサータ', RED, 30, 15, ['automation'], ['fast-inserter']),
  T('optics', '照明', RED, 10, 15, [], ['small-lamp']),
  T('steel-processing', '製鋼', RED, 50, 5, [], ['steel-plate', 'steel-chest']),
  T('logistic-science-pack', '物流サイエンスパック', RED, 75, 5, [], ['logistic-science-pack']),
  T('automation-2', '自動化2', RG, 40, 15, ['electronics', 'steel-processing', 'logistic-science-pack'], ['assembling-machine-2']),
  T('logistics-2', '物流2', RG, 200, 30, ['logistics', 'logistic-science-pack'], ['fast-transport-belt', 'fast-underground-belt', 'fast-splitter']),
  T('electric-energy-distribution-1', '送電1', RG, 120, 30, ['electronics', 'steel-processing', 'logistic-science-pack'], ['medium-electric-pole', 'big-electric-pole']),
  T('advanced-material-processing', '高度な素材加工', RG, 75, 30, ['steel-processing', 'logistic-science-pack'], ['steel-furnace']),
  T('solar-energy', '太陽光発電', RG, 100, 30, ['optics', 'electronics', 'steel-processing', 'logistic-science-pack'], ['solar-panel']),
  T('fluid-handling', '流体の扱い', RG, 50, 15, ['automation-2'], ['storage-tank']),
  T('engine', 'エンジン', RG, 100, 15, ['steel-processing', 'logistic-science-pack'], ['engine-unit']),
  T('oil-processing', '石油処理', RG, 100, 30, ['fluid-handling'], ['pumpjack', 'oil-refinery', 'chemical-plant', 'basic-oil-processing', 'solid-fuel']),
  T('plastics', 'プラスチック', RG, 200, 30, ['oil-processing'], ['plastic-bar']),
  T('advanced-electronics', '発展電子工学', RG, 200, 15, ['plastics', 'electronics'], ['advanced-circuit']),
  T('sulfur-processing', '硫黄処理', RG, 150, 30, ['oil-processing'], ['sulfur', 'sulfuric-acid']),
  T('toolbelt', '道具ベルト', RG, 100, 30, ['logistic-science-pack'], [], { effect: { inventory: 10 } }),
  T('inserter-capacity-bonus-1', 'インサータ容量1', RG, 100, 30, ['fast-inserter', 'logistic-science-pack'], [], { effect: { inserterStack: 1 } }),
  T('mining-productivity-1', '採掘生産性1', RG, 250, 60, ['advanced-material-processing'], [], { effect: { miningProd: 100 } }),
  T('chemical-science-pack', '化学サイエンスパック', RG, 75, 10, ['advanced-electronics', 'sulfur-processing', 'engine'], ['chemical-science-pack']),
  T('battery', '電池', RGB, 150, 30, ['sulfur-processing', 'chemical-science-pack'], ['battery']),
  T('electric-energy-accumulators', '蓄電', RGB, 150, 30, ['electric-energy-distribution-1', 'battery'], ['accumulator']),
  T('advanced-material-processing-2', '高度な素材加工2', RGB, 250, 30, ['advanced-material-processing', 'chemical-science-pack'], ['electric-furnace']),
  T('advanced-electronics-2', '発展電子工学2', RGB, 300, 30, ['chemical-science-pack'], ['processing-unit']),
  T('automation-3', '自動化3', RGB, 150, 30, ['automation-2', 'chemical-science-pack'], ['assembling-machine-3']),
  T('logistics-3', '物流3', RGB, 300, 15, ['logistics-2', 'chemical-science-pack'], ['express-transport-belt', 'express-underground-belt', 'express-splitter']),
  T('inserter-capacity-bonus-2', 'インサータ容量2', RGB, 200, 30, ['inserter-capacity-bonus-1', 'chemical-science-pack'], [], { effect: { inserterStack: 1 } }),
  T('mining-productivity-2', '採掘生産性2', RGB, 250, 60, ['mining-productivity-1', 'chemical-science-pack'], [], { effect: { miningProd: 100 } }),
  T('low-density-structure', '軽量構造材', RGB, 300, 45, ['advanced-material-processing-2', 'chemical-science-pack'], ['low-density-structure']),
  T('rocket-fuel', 'ロケット燃料', RGB, 300, 45, ['chemical-science-pack'], ['rocket-fuel']),
  T('rocket-silo', 'ロケットサイロ', RGB, 500, 30, ['advanced-electronics-2', 'low-density-structure', 'rocket-fuel', 'automation-3'], ['rocket-silo', 'rocket-part']),
];
export const TECHS = Object.fromEntries(techList.map((t, i) => [t.name, { ...t, order: i }]));
export const TECH_LIST = techList.map(t => t.name);

// starting kit for every player that joins
export const START_KIT = [['burner-mining-drill', 2], ['stone-furnace', 2], ['iron-plate', 12], ['wood', 10]];
export const BASE_INVENTORY = 60;
