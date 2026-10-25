/**
 * Wetland Water Mapping with Random Forest (Landsat 5/7/8/9)
 * ---------------------------------------------------------
 * Maps open water in a lake or wetland from a seasonal Landsat Collection 2
 * composite with a Random Forest trained on eight spectral water indices.
 * It reports a hold-out accuracy assessment and variable importance, and can
 * apply the trained model to other years to build a water-area time series.
 *
 * Training data
 *   'auto'  : samples are drawn from the JRC Global Surface Water yearly
 *             history of CONFIG.trainYear (permanent water vs. not water),
 *             so the script runs anywhere without drawing points.
 *   'drawn' : draw two point/polygon layers named "water" and "land" with the
 *             geometry tools. Your own samples usually give the best map.
 *
 * How to run
 *   Paste into https://code.earthengine.google.com, edit CONFIG, press Run,
 *   then start the exports from the Tasks tab.
 *
 * Author: Parisa Abbasalizadehrezaei · https://risarezaei.github.io
 * License: MIT
 */

// =============================== CONFIG ===================================
var CONFIG = {
  // Area to map (example: Lake Urmia). A drawn geometry or an asset works too.
  roi: ee.Geometry.Rectangle([44.95, 37.05, 46.05, 38.30]),

  year: 2025,                    // year to classify
  season: ['07-01', '09-30'],    // month-day window of the composite
  maxSceneCloud: 60,             // skip scenes cloudier than this (%)
  useLandsat7: true,             // L7 has SLC-off gaps after May 2003

  trainingSource: 'auto',        // 'auto' or 'drawn'
  trainYear: 2020,               // reference year for 'auto' (1984-2021)
  samplesPerClass: 500,

  features: ['NDVI', 'NDWI', 'MNDWI', 'AWEInsh', 'AWEIsh', 'WRI', 'NWI', 'EWI'],
  nTrees: 100,
  trainFraction: 0.7,            // the rest is kept for validation
  seed: 42,

  // Apply the model to these years and chart the water area ([] to skip).
  seriesYears: [1985, 1990, 1995, 2000, 2005, 2010, 2015, 2020, 2025],
  areaScale: 60,                 // metres; coarser is faster for large lakes

  exportMap: true,
  exportTables: true,
  driveFolder: 'earthengine',
  filePrefix: 'wetland_water_rf'
};
// ==========================================================================

var roi = CONFIG.roi;
var NAMES = ['blue', 'green', 'red', 'nir', 'swir1', 'swir2'];

// ---- Landsat Collection 2 Level-2 surface reflectance -------------------
function prepare(bands) {
  return function (img) {
    var qa = img.select('QA_PIXEL');
    var clear = qa.bitwiseAnd(1 << 1).eq(0)        // dilated cloud
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

function landsat(year) {
  var start = ee.Date(year + '-' + CONFIG.season[0]);
  var end = ee.Date(year + '-' + CONFIG.season[1]).advance(1, 'day');
  function get(id, bands) {
    return ee.ImageCollection(id).filterBounds(roi).filterDate(start, end)
      .filter(ee.Filter.lt('CLOUD_COVER', CONFIG.maxSceneCloud))
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

samples = samples.randomColumn('rand', CONFIG.seed);
var training = samples.filter(ee.Filter.lt('rand', CONFIG.trainFraction));
var validation = samples.filter(ee.Filter.gte('rand', CONFIG.trainFraction));

var classifier = ee.Classifier.smileRandomForest({
  numberOfTrees: CONFIG.nTrees, seed: CONFIG.seed
}).train({features: training, classProperty: 'class', inputProperties: CONFIG.features});

// ---- Accuracy assessment (hold-out) -------------------------------------
var cm = validation.classify(classifier).errorMatrix('class', 'classification', [0, 1]);
print('Samples (training / validation)', training.size(), validation.size());
print('Confusion matrix (rows = reference, cols = predicted; 0 = land, 1 = water)', cm);
print('Overall accuracy', cm.accuracy());
print('Kappa', cm.kappa());
print('Producer\'s accuracy [land, water]', cm.producersAccuracy());
print('User\'s accuracy [land, water]', cm.consumersAccuracy());

// ---- Variable importance -------------------------------------------------
var importance = ee.Dictionary(ee.Dictionary(classifier.explain()).get('importance'));
print(ui.Chart.array.values({
  array: importance.values(CONFIG.features), axis: 0, xLabels: CONFIG.features
}).setChartType('ColumnChart').setOptions({
  title: 'Random Forest variable importance', legend: {position: 'none'},
  colors: ['1e88e5'], vAxis: {title: 'Importance'}
}));

// ---- Classification of the target year ----------------------------------
var image = composite(CONFIG.year);
var classified = image.select(CONFIG.features).classify(classifier).rename('water').toByte();

var pixelKm2 = ee.Image.pixelArea().divide(1e6);
function waterArea(cls) {
  return pixelKm2.updateMask(cls.eq(1)).reduceRegion({
    reducer: ee.Reducer.sum(), geometry: roi, scale: CONFIG.areaScale,
    maxPixels: 1e13, tileScale: 4
  }).values().get(0);
}
print('Water area ' + CONFIG.year + ' (km²)', waterArea(classified));

Map.centerObject(roi, 9);
Map.addLayer(image, {bands: ['swir1', 'nir', 'green'], min: 0, max: 0.35}, 'Composite (SWIR1-NIR-G)');
Map.addLayer(classified.selfMask(), {palette: ['1e88e5']}, 'Water ' + CONFIG.year);
Map.addLayer(samples.filter(ee.Filter.eq('class', 1)), {color: '00e5ff'}, 'Water samples', false);
Map.addLayer(samples.filter(ee.Filter.eq('class', 0)), {color: 'ffb300'}, 'Land samples', false);

// ---- Water-area time series ---------------------------------------------
var series = ee.FeatureCollection(CONFIG.seriesYears.map(function (y) {
  var col = landsat(y);
  var cls = addIndices(median(col).clip(roi)).select(CONFIG.features).classify(classifier);
  return ee.Feature(null, {year: y, water_km2: waterArea(cls), n_scenes: col.size()});
}));

if (CONFIG.seriesYears.length) {
  print(ui.Chart.feature.byFeature(series, 'year', ['water_km2'])
    .setChartType('LineChart').setOptions({
      title: 'Open-water area (' + CONFIG.season.join(' to ') + ' composites)',
      hAxis: {title: 'Year', format: '####'}, vAxis: {title: 'km²'},
      pointSize: 5, lineWidth: 2, colors: ['1e88e5'], legend: {position: 'none'}
    }));
  print('Water-area series', series);
}

// ---- Exports -------------------------------------------------------------
if (CONFIG.exportMap) {
  Export.image.toDrive({
    image: classified, description: CONFIG.filePrefix + '_' + CONFIG.year,
    folder: CONFIG.driveFolder, region: roi, scale: 30, maxPixels: 1e13
  });
}
if (CONFIG.exportTables) {
  var acc = ee.FeatureCollection([ee.Feature(null, {
    overall_accuracy: cm.accuracy(), kappa: cm.kappa(),
    producers_land: cm.producersAccuracy().get([0, 0]),
    producers_water: cm.producersAccuracy().get([1, 0]),
    users_land: cm.consumersAccuracy().get([0, 0]),
    users_water: cm.consumersAccuracy().get([0, 1]),
    n_training: training.size(), n_validation: validation.size()
  }).set(importance)]);
  Export.table.toDrive({collection: acc, description: CONFIG.filePrefix + '_accuracy',
    folder: CONFIG.driveFolder, fileFormat: 'CSV'});
  if (CONFIG.seriesYears.length) {
    Export.table.toDrive({collection: series, description: CONFIG.filePrefix + '_area_series',
      folder: CONFIG.driveFolder, fileFormat: 'CSV', selectors: ['year', 'water_km2', 'n_scenes']});
  }
}
