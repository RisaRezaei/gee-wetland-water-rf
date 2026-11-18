/**
 * Wetland Water Mapping with Random Forest (Landsat 5/7/8/9)
 * ---------------------------------------------------------
 * Maps open water in a lake or wetland from a seasonal Landsat Collection 2
 * composite with a Random Forest trained on eight spectral water indices,
 * and applies the same model to other years to build a water-area series.
 *
 * Training data
 *   'auto'  : samples are drawn from the JRC Global Surface Water yearly
 *             history of CONFIG.trainYear (permanent water vs. not water),
 *             so the script runs anywhere without drawing points.
 *   'drawn' : draw two point/polygon layers named "water" and "land" with the
 *             geometry tools. Your own samples usually give the best map.
 *
 * Accuracy
 *   1. Hold-out check. The training samples are split by spatial blocks, so
 *      neighbouring samples do not end up on both sides of the split. These
 *      samples are not a probability sample of the map: the numbers describe
 *      the model, not the map.
 *   2. Map accuracy and area. A separate stratified random sample of the map
 *      of CONFIG.assessment.year (strata: mapped land and water), labelled
 *      from the JRC monthly water history of the same months or from your own
 *      labelled points. Reported as overall, user's and producer's accuracy
 *      and an area estimate per class, each with a 95 % confidence interval
 *      (Olofsson et al., 2014), plus quantity and allocation disagreement
 *      (Pontius & Millones, 2011).
 *
 * Coverage
 *   Every year of the series reports the observed (cloud-free) area, its
 *   share of the ROI and the cloud percentage of the season. Years below
 *   CONFIG.minObservedFraction are flagged and left out of the chart, so
 *   missing observations are not read as water loss.
 *
 * How to run
 *   Paste into https://code.earthengine.google.com, edit CONFIG, press Run,
 *   then start the exports from the Tasks tab.
 *
 * Author: Parisa Abbasalizadehrezaei · https://risarezaei.github.io
 * License: MIT · Version 1.1.0
 */

// =============================== CONFIG ===================================
// Two example areas. Lake Urmia is large and mostly cloud-free in summer.
// Loktak Lake (India) is small, partly covered by floating vegetation and
// cloudy in the July-September monsoon, so its coverage check matters.
var EXAMPLES = {
  urmia: ee.Geometry.Rectangle([44.95, 37.05, 46.05, 38.30]),
  loktak: ee.Geometry.Rectangle([93.72, 24.40, 93.90, 24.66])
};

var CONFIG = {
  // Area to map: one of the examples above, a drawn geometry or an asset.
  roi: EXAMPLES.urmia,

  year: 2025,                    // year to classify
  season: ['07-01', '09-30'],    // month-day window of the composite (one calendar year)
  maxSceneCloud: 60,             // skip scenes cloudier than this (%)
  useLandsat7: true,             // L7 has SLC-off gaps after May 2003

  trainingSource: 'auto',        // 'auto' or 'drawn'
  trainYear: 2020,               // reference year for 'auto' (1984-2021)
  samplesPerClass: 500,

  features: ['NDVI', 'NDWI', 'MNDWI', 'AWEInsh', 'AWEIsh', 'WRI', 'NWI', 'EWI'],
  nTrees: 100,
  trainFraction: 0.7,            // share of blocks used for training; the rest is the hold-out
  blockSize: 2000,               // block edge (m) for the split; 0 splits point by point
  seed: 42,

  // Map accuracy and area estimate (Olofsson et al., 2014).
  assessment: {
    year: 2020,                  // map to assess; 1984-2021 when JRC is the reference
    pointsPerClass: [250, 250],  // stratified random sample: [land, water]
    referencePoints: null        // or a table asset with your own labels (see README)
  },

  // Apply the model to these years and chart the water area ([] to skip).
  seriesYears: [1985, 1990, 1995, 2000, 2005, 2010, 2015, 2020, 2025],
  areaScale: 60,                 // metres; coarser is faster for large lakes
  minObservedFraction: 0.95,     // years with less of the ROI observed are flagged

  exportMap: true,
  exportTables: true,
  driveFolder: 'earthengine',
  filePrefix: 'wetland_water_rf'
};
// ==========================================================================

// The composite window must lie within one calendar year (not, for example,
// '11-01' to '02-28'); otherwise every composite would be empty.
if (CONFIG.season[1] < CONFIG.season[0]) {
  throw new Error('CONFIG.season must start and end in the same calendar year.');
}

var roi = CONFIG.roi;
var NAMES = ['blue', 'green', 'red', 'nir', 'swir1', 'swir2'];

// ---- Landsat Collection 2 Level-2 surface reflectance -------------------
function prepare(bands) {
  return function (img) {
    var qa = img.select('QA_PIXEL');
    var clear = qa.bitwiseAnd(1).eq(0)            // fill
      .and(qa.bitwiseAnd(1 << 1).eq(0))           // dilated cloud
      .and(qa.bitwiseAnd(1 << 3).eq(0))           // cloud
      .and(qa.bitwiseAnd(1 << 4).eq(0))           // cloud shadow
      .and(img.select('QA_RADSAT').eq(0));        // saturation
    return img.select(bands, NAMES)
      .multiply(0.0000275).add(-0.2)
      .updateMask(clear)
      .copyProperties(img, ['system:time_start']);
  };
}

var L57 = ['SR_B1', 'SR_B2', 'SR_B3', 'SR_B4', 'SR_B5', 'SR_B7'];
var L89 = ['SR_B2', 'SR_B3', 'SR_B4', 'SR_B5', 'SR_B6', 'SR_B7'];

// Per scene: 'cloudy' = cloud or cloud shadow, 'valid' = pixel holds data.
function cloudFlags(img) {
  var qa = img.select('QA_PIXEL');
  var valid = qa.bitwiseAnd(1).eq(0);
  var cloudy = qa.bitwiseAnd((1 << 1) | (1 << 3) | (1 << 4)).neq(0).and(valid);
  return cloudy.rename('cloudy').addBands(valid.rename('valid')).toUint16();
}

// Landsat scenes of the season over the ROI. The composite uses the scenes
// below maxSceneCloud; with cloudsOnly = true every scene of the season is
// returned as cloud flags, for the cloud statistics.
function landsat(year, cloudsOnly) {
  var start = ee.Date(year + '-' + CONFIG.season[0]);
  var end = ee.Date(year + '-' + CONFIG.season[1]).advance(1, 'day');
  function get(id, bands) {
    var col = ee.ImageCollection(id).filterBounds(roi).filterDate(start, end);
    if (cloudsOnly) return col.map(cloudFlags);
    return col.filter(ee.Filter.lt('CLOUD_COVER', CONFIG.maxSceneCloud))
      .map(prepare(bands));
  }
  var col = get('LANDSAT/LT05/C02/T1_L2', L57)
    .merge(get('LANDSAT/LC08/C02/T1_L2', L89))
    .merge(get('LANDSAT/LC09/C02/T1_L2', L89));
  if (CONFIG.useLandsat7) col = col.merge(get('LANDSAT/LE07/C02/T1_L2', L57));
  return col;
}

// ---- Spectral water indices ---------------------------------------------
function addIndices(img) {
  var b = function (n) { return img.select(n); };
  var nd = function (a, c, name) { return img.normalizedDifference([a, c]).rename(name); };
  var awein = b('green').subtract(b('swir1')).multiply(4)
    .subtract(b('nir').multiply(0.25).add(b('swir2').multiply(2.75))).rename('AWEInsh');
  var awei = b('blue').add(b('green').multiply(2.5))
    .subtract(b('nir').add(b('swir1')).multiply(1.5))
    .subtract(b('swir2').multiply(0.25)).rename('AWEIsh');
  var wri = b('green').add(b('red')).divide(b('nir').add(b('swir1'))).rename('WRI');
  var s3 = b('nir').add(b('swir1')).add(b('swir2'));
  var nwi = b('blue').subtract(s3).divide(b('blue').add(s3)).rename('NWI');
  var gns = b('green').add(b('nir')).add(b('swir1'));
  var ewi = b('green').subtract(b('nir')).subtract(b('swir1')).divide(gns).rename('EWI');
  return img.addBands([nd('nir', 'red', 'NDVI'), nd('green', 'nir', 'NDWI'),
    nd('green', 'swir1', 'MNDWI'), awein, awei, wri, nwi, ewi]);
}

// Median composite; a fully masked placeholder if the year has no scenes.
function median(col) {
  var empty = ee.Image.constant([0, 0, 0, 0, 0, 0]).rename(NAMES).updateMask(0);
  return ee.Image(ee.Algorithms.If(col.size().gt(0), col.median(), empty));
}

function composite(year) {
  return addIndices(median(landsat(year)).clip(roi));
}

// ---- Training samples ----------------------------------------------------
var samples;
if (CONFIG.trainingSource === 'drawn') {
  // Expects "water" and "land" drawn with the geometry tools.
  var asFc = function (x, cls) {
    return ee.FeatureCollection(x).map(function (f) { return f.set('class', cls); });
  };
  samples = composite(CONFIG.year).select(CONFIG.features).sampleRegions({
    collection: asFc(water, 1).merge(asFc(land, 0)),
    properties: ['class'], scale: 30, geometries: true, tileScale: 4
  });
} else {
  // JRC yearly history: 1 = not water, 2 = seasonal, 3 = permanent water.
  var hist = ee.ImageCollection('JRC/GSW1_4/YearlyHistory')
    .filter(ee.Filter.eq('year', CONFIG.trainYear)).first().select('waterClass');
  var label = hist.eq(3).where(hist.eq(1), 0).updateMask(hist.eq(1).or(hist.eq(3)))
    .rename('class').toInt();
  samples = composite(CONFIG.trainYear).select(CONFIG.features).addBands(label)
    .stratifiedSample({
      numPoints: CONFIG.samplesPerClass, classBand: 'class', region: roi,
      scale: 30, seed: CONFIG.seed, geometries: true, tileScale: 4
    });
}

// ---- Train / hold-out split by spatial blocks ----------------------------
// Each sample takes the random number of the square block it falls in, so
// whole blocks go to training or to the hold-out set.
if (CONFIG.blockSize > 0) {
  samples = ee.Image.random(CONFIG.seed).reduceRegions({
    collection: samples, reducer: ee.Reducer.first().setOutputs(['rand']),
    scale: CONFIG.blockSize, crs: 'EPSG:3857'
  });
} else {
  samples = samples.randomColumn('rand', CONFIG.seed);
}
var training = samples.filter(ee.Filter.lt('rand', CONFIG.trainFraction));
var holdout = samples.filter(ee.Filter.gte('rand', CONFIG.trainFraction));

var classifier = ee.Classifier.smileRandomForest({
  numberOfTrees: CONFIG.nTrees, seed: CONFIG.seed
}).train({features: training, classProperty: 'class', inputProperties: CONFIG.features});

function classify(img) {
  return img.select(CONFIG.features).classify(classifier).rename('water').toByte();
}

// ---- 1) Hold-out check ---------------------------------------------------
var cm = holdout.classify(classifier).errorMatrix('class', 'classification', [0, 1]);
print('1) HOLD-OUT CHECK: training-type samples, split by ' +
  (CONFIG.blockSize > 0 ? CONFIG.blockSize + ' m blocks' : 'point') +
  '. Describes the model, not the map.');
print('Samples (training / hold-out)', training.size(), holdout.size());
print('Confusion matrix (rows = reference, cols = predicted; 0 = land, 1 = water)', cm);
print('Overall accuracy', cm.accuracy());
print("Producer's accuracy [land, water]", cm.producersAccuracy());
print("User's accuracy [land, water]", cm.consumersAccuracy());
print('Kappa (for comparison only; see the disagreement measures in part 2)', cm.kappa());

// ---- Variable importance -------------------------------------------------
var importance = ee.Dictionary(ee.Dictionary(classifier.explain()).get('importance'));
print(ui.Chart.array.values({
  array: importance.values(CONFIG.features), axis: 0, xLabels: CONFIG.features
}).setChartType('ColumnChart').setOptions({
  title: 'Random Forest variable importance', legend: {position: 'none'},
  colors: ['1e88e5'], vAxis: {title: 'Importance'}
}));

// ---- Areas and coverage --------------------------------------------------
var pixelKm2 = ee.Image.pixelArea().divide(1e6);

function roundTo(x, digits) {
  var k = Math.pow(10, digits);
  return ee.Number(x).multiply(k).round().divide(k);
}

// Water area, observed (cloud-free) area and the observed share of the ROI.
function areaStats(cls) {
  var s = ee.Image.cat(
    pixelKm2.updateMask(cls.eq(1)).rename('water_km2'),
    pixelKm2.updateMask(cls.mask()).rename('observed_km2'),
    pixelKm2.rename('roi_km2')
  ).reduceRegion({
    reducer: ee.Reducer.sum(), geometry: roi, scale: CONFIG.areaScale,
    maxPixels: 1e13, tileScale: 4
  });
  var frac = ee.Number(s.get('observed_km2')).divide(s.get('roi_km2'));
  return ee.Dictionary({
    water_km2: roundTo(s.get('water_km2'), 2),
    observed_km2: roundTo(s.get('observed_km2'), 2),
    observed_frac: roundTo(frac, 4),
    low_coverage: frac.lt(CONFIG.minObservedFraction)
  });
}

// Cloud and cloud-shadow share (%) of all observations of the ROI in the
// season, counting every scene (also those skipped by maxSceneCloud).
// Empty (null) when the season has no scene at all.
function cloudPct(year) {
  var flags = landsat(year, true);
  var counts = ee.Image(ee.Algorithms.If(flags.size().gt(0), flags.sum(),
    ee.Image.constant([0, 0]).rename(['cloudy', 'valid'])))
    .reduceRegion({
      reducer: ee.Reducer.sum(), geometry: roi, scale: CONFIG.areaScale,
      maxPixels: 1e13, tileScale: 4
    });
  var valid = ee.Number(counts.get('valid'));
  return ee.Algorithms.If(valid.gt(0),
    roundTo(ee.Number(counts.get('cloudy')).divide(valid).multiply(100), 1), null);
}

// ---- Classification of the target year ----------------------------------
var image = composite(CONFIG.year);
var classified = classify(image);
var target = areaStats(classified);
print('Water area ' + CONFIG.year + ' (km²)', target.get('water_km2'));
print('Share of the ROI observed in ' + CONFIG.year, target.get('observed_frac'));
print('Cloud and cloud-shadow share of all observations in ' + CONFIG.year + ' (%)',
  cloudPct(CONFIG.year));

// ---- 2) Map accuracy and area (Olofsson et al., 2014) --------------------
var ASSESS = CONFIG.assessment;
var useJrc = !ASSESS.referencePoints && ASSESS.year <= 2021;
var hasReference = useJrc || !!ASSESS.referencePoints;
var assessMap = classify(composite(ASSESS.year)).rename('map');

// Reference labels from the JRC monthly water history for the months of the
// composite: water if the pixel was water in at least half of the months in
// which JRC observed it. Pixels JRC never observed in those months are left
// out of the sampling frame.
function jrcReference(year) {
  var m0 = parseInt(CONFIG.season[0].slice(0, 2), 10);
  var m1 = parseInt(CONFIG.season[1].slice(0, 2), 10);
  var months = ee.ImageCollection('JRC/GSW1_4/MonthlyHistory')
    .filter(ee.Filter.eq('year', year))
    .filter(ee.Filter.rangeContains('month', m0, m1))
    .map(function (m) { return m.select('water').unmask(0); }); // 0 no data, 1 not water, 2 water
  var waterMonths = months.map(function (m) { return m.eq(2); }).sum();
  var seenMonths = months.map(function (m) { return m.gt(0); }).sum();
  return waterMonths.multiply(2).gte(seenMonths).rename('reference').toByte()
    .updateMask(seenMonths.gt(0));
}

var reference = useJrc ? jrcReference(ASSESS.year) : null;
var strata = useJrc ? assessMap.updateMask(reference.mask()) : assessMap;

// Stratified random sample: fixed number of points in mapped land and water.
var points;
if (ASSESS.referencePoints) {
  // Your labels: a table with a 'reference' property (0 = land, 1 = water)
  // at the points of an earlier stratified sample of this same map.
  points = strata.sampleRegions({
    collection: ee.FeatureCollection(ASSESS.referencePoints),
    properties: ['reference'], scale: 30, geometries: true
  });
} else {
  points = (useJrc ? strata.addBands(reference) : strata).stratifiedSample({
    numPoints: ASSESS.pointsPerClass[1], classBand: 'map', classValues: [0, 1],
    classPoints: ASSESS.pointsPerClass, region: roi, scale: 30,
    seed: CONFIG.seed + 1, geometries: true, tileScale: 4
  });
}
points = points.map(function (f) {
  var xy = f.geometry().coordinates();
  return f.set({lon: xy.get(0), lat: xy.get(1)});
});

// Mapped area of each class inside the sampling frame (the stratum sizes).
var frame = ee.Image.cat(
  pixelKm2.updateMask(strata.eq(0)).rename('land'),
  pixelKm2.updateMask(strata.eq(1)).rename('water'),
  pixelKm2.rename('roi')
).reduceRegion({
  reducer: ee.Reducer.sum(), geometry: roi, scale: 30, maxPixels: 1e13, tileScale: 4
});

// Stratified estimators for two classes (Olofsson et al., 2014).
// n: point counts, rows = map class, columns = reference class.
// mapped: mapped area (km²) of each class.
function olofsson(n, mapped) {
  var K = [0, 1];
  var total = mapped[0].add(mapped[1]);
  var W = K.map(function (i) { return mapped[i].divide(total); });      // stratum weights
  var cnt = function (i, j) { return ee.Number(n.get([i, j])); };
  var ni = K.map(function (i) { return cnt(i, 0).add(cnt(i, 1)); });   // points per stratum
  var f = function (i, j) { return cnt(i, j).divide(ni[i].max(1)); };   // n_ij / n_i.
  var v = function (i, j) {                                            // f (1 - f) / (n_i. - 1)
    return f(i, j).multiply(ee.Number(1).subtract(f(i, j))).divide(ni[i].subtract(1).max(1));
  };
  var p = function (i, j) { return W[i].multiply(f(i, j)); };           // area proportions
  var pRef = K.map(function (j) { return p(0, j).add(p(1, j)); });      // reference proportions

  var classes = K.map(function (j) {
    var o = 1 - j;
    var pa = p(j, j).divide(pRef[j].max(1e-12));
    var refArea = total.multiply(pRef[j]);
    // Variance of producer's accuracy (Olofsson et al., 2014, eq. 7).
    var varPa = mapped[j].pow(2).multiply(ee.Number(1).subtract(pa).pow(2)).multiply(v(j, j))
      .add(pa.pow(2).multiply(mapped[o].pow(2)).multiply(v(o, j)))
      .divide(refArea.pow(2).max(1e-12));
    var seArea = W[0].pow(2).multiply(v(0, j)).add(W[1].pow(2).multiply(v(1, j)))
      .sqrt().multiply(total);
    return ee.Feature(null, {
      'class': ['land', 'water'][j],
      mapped_km2: roundTo(mapped[j], 2),
      adjusted_km2: roundTo(refArea, 2),
      adjusted_ci95_km2: roundTo(seArea.multiply(1.96), 2),
      users_accuracy: roundTo(f(j, j), 4),
      users_ci95: roundTo(v(j, j).sqrt().multiply(1.96), 4),
      producers_accuracy: roundTo(pa, 4),
      producers_ci95: roundTo(varPa.sqrt().multiply(1.96), 4),
      n_points: ni[j]
    });
  });

  var oa = p(0, 0).add(p(1, 1));
  var seOa = W[0].pow(2).multiply(v(0, 0)).add(W[1].pow(2).multiply(v(1, 1))).sqrt();
  // Pontius & Millones (2011): 1 - overall accuracy = quantity + allocation.
  var quantity = ee.Number(0);
  var allocation = ee.Number(0);
  K.forEach(function (g) {
    quantity = quantity.add(pRef[g].subtract(W[g]).abs());
    allocation = allocation.add(
      W[g].subtract(p(g, g)).min(pRef[g].subtract(p(g, g))).multiply(2));
  });
  return {
    classes: ee.FeatureCollection(classes),
    overall: ee.Dictionary({
      overall_accuracy: roundTo(oa, 4),
      overall_ci95: roundTo(seOa.multiply(1.96), 4),
      quantity_disagreement: roundTo(quantity.divide(2), 4),
      allocation_disagreement: roundTo(allocation.divide(2), 4),
      frame_km2: roundTo(total, 2)
    })
  };
}

var mapAccuracy = null;
if (hasReference) {
  var n = points.errorMatrix('map', 'reference', [0, 1]).array();
  var mapped = [ee.Number(frame.get('land')), ee.Number(frame.get('water'))];
  var est = olofsson(n, mapped);
  var overall = est.overall.set('frame_share_of_roi',
    roundTo(mapped[0].add(mapped[1]).divide(frame.get('roi')), 4));
  mapAccuracy = est.classes.merge(ee.FeatureCollection([ee.Feature(null, overall).set({
    'class': 'overall', map_year: ASSESS.year,
    reference: useJrc ? 'JRC monthly history' : 'user labels'
  })]));

  print('2) MAP ACCURACY AND AREA, ' + ASSESS.year + ' map. Stratified random sample, ' +
    'reference: ' + (useJrc ? 'JRC monthly water history' : 'your labels') +
    '. Area-weighted estimates with 95 % confidence intervals (Olofsson et al., 2014).');
  print(ui.Chart.feature.byFeature(est.classes, 'class', [
    'mapped_km2', 'adjusted_km2', 'adjusted_ci95_km2', 'users_accuracy', 'users_ci95',
    'producers_accuracy', 'producers_ci95', 'n_points'
  ]).setChartType('Table'));
  print('Overall accuracy, quantity and allocation disagreement (Pontius & Millones, 2011)', overall);
} else {
  print('2) MAP ACCURACY: JRC monthly history ends in 2021. Label the exported ' +
    'validation points and set CONFIG.assessment.referencePoints (see README).');
}

// ---- Map -----------------------------------------------------------------
Map.centerObject(roi);
Map.addLayer(image, {bands: ['swir1', 'nir', 'green'], min: 0, max: 0.35}, 'Composite (SWIR1-NIR-G)');
Map.addLayer(classified.selfMask(), {palette: ['1e88e5']}, 'Water ' + CONFIG.year);
Map.addLayer(samples.filter(ee.Filter.eq('class', 1)), {color: '00e5ff'}, 'Water samples', false);
Map.addLayer(samples.filter(ee.Filter.eq('class', 0)), {color: 'ffb300'}, 'Land samples', false);
Map.addLayer(points, {color: 'ff1744'}, 'Assessment points ' + ASSESS.year, false);

// ---- Water-area time series with coverage --------------------------------
var series = ee.FeatureCollection(CONFIG.seriesYears.map(function (y) {
  var col = landsat(y);
  var stats = areaStats(classify(addIndices(median(col).clip(roi))));
  return ee.Feature(null, stats).set({year: y, n_scenes: col.size(), cloud_pct: cloudPct(y)});
}));

if (CONFIG.seriesYears.length) {
  var pct = Math.round(CONFIG.minObservedFraction * 100);
  print(ui.Chart.feature.byFeature(series.filter(ee.Filter.eq('low_coverage', 0)),
    'year', ['water_km2']).setChartType('LineChart').setOptions({
      title: 'Open-water area (' + CONFIG.season.join(' to ') + ' composites, years with ≥ ' +
        pct + ' % of the ROI observed)',
      hAxis: {title: 'Year', format: '####'}, vAxis: {title: 'km²'},
      pointSize: 5, lineWidth: 2, colors: ['1e88e5'], legend: {position: 'none'}
    }));
  print('Years left out of the chart (less than ' + pct + ' % of the ROI observed)',
    series.filter(ee.Filter.eq('low_coverage', 1)).aggregate_array('year'));
  print(ui.Chart.feature.byFeature(series, 'year',
    ['water_km2', 'observed_km2', 'observed_frac', 'cloud_pct', 'n_scenes', 'low_coverage'])
    .setChartType('Table'));
}

// ---- Exports -------------------------------------------------------------
if (CONFIG.exportMap) {
  Export.image.toDrive({
    image: classified, description: CONFIG.filePrefix + '_' + CONFIG.year,
    folder: CONFIG.driveFolder, region: roi, scale: 30, maxPixels: 1e13
  });
}
if (CONFIG.exportTables) {
  var holdoutTable = ee.FeatureCollection([ee.Feature(null, {
    overall_accuracy: cm.accuracy(), kappa: cm.kappa(),
    producers_land: cm.producersAccuracy().get([0, 0]),
    producers_water: cm.producersAccuracy().get([1, 0]),
    users_land: cm.consumersAccuracy().get([0, 0]),
    users_water: cm.consumersAccuracy().get([0, 1]),
    n_training: training.size(), n_holdout: holdout.size(),
    block_size_m: CONFIG.blockSize
  }).set(importance)]);
  Export.table.toDrive({collection: holdoutTable, description: CONFIG.filePrefix + '_holdout',
    folder: CONFIG.driveFolder, fileFormat: 'CSV'});

  if (mapAccuracy) {
    Export.table.toDrive({collection: mapAccuracy,
      description: CONFIG.filePrefix + '_map_accuracy',
      folder: CONFIG.driveFolder, fileFormat: 'CSV', selectors: ['class', 'mapped_km2',
        'adjusted_km2', 'adjusted_ci95_km2', 'users_accuracy', 'users_ci95',
        'producers_accuracy', 'producers_ci95', 'n_points', 'overall_accuracy',
        'overall_ci95', 'quantity_disagreement', 'allocation_disagreement',
        'frame_km2', 'frame_share_of_roi', 'map_year', 'reference']});
  }
  Export.table.toDrive({collection: points,
    description: CONFIG.filePrefix + '_assessment_points_' + ASSESS.year,
    folder: CONFIG.driveFolder, fileFormat: 'CSV',
    selectors: hasReference ? ['lon', 'lat', 'map', 'reference'] : ['lon', 'lat', 'map']});

  if (CONFIG.seriesYears.length) {
    Export.table.toDrive({collection: series, description: CONFIG.filePrefix + '_area_series',
      folder: CONFIG.driveFolder, fileFormat: 'CSV', selectors: ['year', 'water_km2',
        'observed_km2', 'observed_frac', 'cloud_pct', 'low_coverage', 'n_scenes']});
  }
}
