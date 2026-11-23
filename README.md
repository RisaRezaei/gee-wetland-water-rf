# Wetland Water Mapping with Random Forest

[![Google Earth Engine](https://img.shields.io/badge/Google%20Earth%20Engine-JavaScript-34A853?logo=googleearth&logoColor=white)](https://code.earthengine.google.com)
[![Landsat](https://img.shields.io/badge/data-Landsat%205%2F7%2F8%2F9%20C2-0B5394)](https://developers.google.com/earth-engine/datasets/catalog/landsat)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.23646350.svg)](https://doi.org/10.5281/zenodo.23646350)

Map **open water in lakes and wetlands** from Landsat with a **Random Forest** classifier trained on six reflectance bands and eight spectral water indices. Every month of the season is classified on its own, and a pixel is water if it was water in at least half of the months in which it was observed, so the map also shows how often each pixel held water. The script assesses the map with a **stratified random sample** and reports **area-adjusted accuracy and area with 95 % confidence intervals**, then applies the same model to other years to build a **water-area time series** back to 1984, with the observed area and cloud percentage of every year so that clouds are not mistaken for water loss.

![Lake Urmia open water in 1995 and 2025 with the water-area series and accuracy](docs/preview.png)

<sub>Example output for Lake Urmia (version 1.2.0 settings): classified open water in summer 1995 and 2025, the area series, and the hold-out accuracy.</sub>

## What the script does

1. Builds a cloud-masked **median composite of each month of the season** from Landsat 5, 7, 8 and 9 Collection 2 surface reflectance (or one composite of the whole season with `mapping: 'seasonal'`, as in version 1.2.0).
2. Uses the six reflectance bands (blue, green, red, NIR, SWIR1, SWIR2) and eight water and vegetation indices: NDVI, NDWI, MNDWI, AWEI<sub>nsh</sub>, AWEI<sub>sh</sub>, WRI, NWI and EWI.
3. Gets **training samples** in one of two ways:
   - `'auto'`: stratified samples labelled from the [JRC Global Surface Water](https://global-surface-water.appspot.com/) monthly history, in four training years (1990, 2000, 2010, 2020) so that the model sees Landsat 5, 7 and 8. Each month's composite is labelled with JRC's map of that same month. Each composite is sampled in four strata: stable water, other water (shores, seasonal water), land that has been water since 1984 (dry lake bed, shores) and other land, so the hard cases are in the training data. It runs anywhere with no drawing.
   - `'drawn'`: your own points or polygons, drawn as two layers named `water` and `land`.
4. Classifies every monthly composite. A pixel is **water if it was water in at least half of its observed months**, the same rule the JRC reference uses. The map comes with the **water frequency** (share of the observed months that were water) and the **water probability** (mean share of the trees voting water), so seasonal water and uncertain shore pixels are visible.
5. Splits the samples by **spatial blocks** and runs a **hold-out check** (confusion matrix, overall, producer's and user's accuracy, kappa).
6. Charts **variable importance** for the 14 inputs.
7. Assesses the **map** with a separate stratified random sample and reports area-weighted accuracy, an **area estimate per class**, and **quantity and allocation disagreement** (see below).
8. Maps the target year and, optionally, a list of years. Each year reports the **water area**, the **observed area**, the **observed share of the ROI** and the **cloud percentage** of the season; years below a coverage threshold are flagged.

## Quick start

1. Open the [Earth Engine Code Editor](https://code.earthengine.google.com).
2. Paste [`wetland_water_rf.js`](wetland_water_rf.js) into a new script.
3. Set `roi` and `year` in `CONFIG` (the default is Lake Urmia, 2025).
4. Press **Run**. The two accuracy blocks, importance and the area series appear in the Console; the water map is added to the Map.
5. Start the GeoTIFF and CSV exports from the **Tasks** tab.

## How accuracy is assessed

The script reports two things, and they answer different questions.

**1. Hold-out check (describes the model).** The training samples are split into training and hold-out sets by square blocks (`blockSize`, 2 km by default): every sample takes the random number of the block it falls in, so neighbouring samples, which look alike, stay on the same side. The samples are drawn per stratum, not at random over the map, so this check tells you whether the model learned the classes. It does not estimate the accuracy of the map.

**2. Map accuracy and area (describes the map).** Following Olofsson et al. (2014):

- **Sampling design:** a stratified random sample of the map of `assessment.year`, with mapped land and mapped water as strata (250 points each by default). This is a probability sample of the whole map, so its estimates are design-unbiased and need no correction for spatial autocorrelation (Wadoux et al., 2021).
- **Response design:** each point is labelled from the JRC Global Surface Water **monthly** history of the same months as the composite. A pixel is water if JRC saw water in at least half of the months in which it observed it. Pixels that JRC never observed in those months are left out of the sampling frame, and the share of the ROI that remains is reported (`frame_share_of_roi`).
- **Analysis:** the counts are turned into an area-weighted error matrix with the mapped area of each stratum. The script reports overall, user's and producer's accuracy and an **area estimate per class**, each with a **95 % confidence interval**, and splits the total disagreement (1 − overall accuracy) into **quantity disagreement** and **allocation disagreement** (Pontius & Millones, 2011). Kappa is kept only in the hold-out check, for comparison.

With JRC as the reference, the numbers measure **agreement with JRC Global Surface Water**, which is itself a Landsat product. For a stricter assessment, label the points yourself:

1. Run the script and export `wetland_water_rf_assessment_points_<year>.csv` (columns `lon`, `lat`, `map`, `reference`).
2. Check or correct the `reference` column (0 = land, 1 = water) by visual interpretation, for example on high-resolution imagery of the same season.
3. Upload the CSV as a table asset and set `assessment.referencePoints` to its asset ID. Keep the other settings unchanged so the map is the same.

This also works for years after 2021, which JRC does not cover.

## Model tests

### Version 1.3.0: monthly maps and water frequency

Up to version 1.2.0, each year was one median composite of the whole season. Large Landsat water products classify every observation instead and then count how often a pixel was water: JRC Global Surface Water builds monthly maps (Pekel et al., 2016), Water Observations from Space classifies every scene (Mueller et al., 2016), and the GLAD water dynamics maps classify all 3.4 million Landsat 5, 7 and 8 scenes from 1999 to 2018 (Pickens et al., 2020). A seasonal median can mix water and dry observations into a spectrum that is neither, and it hides how long a pixel held water.

Version 1.3.0 classifies each month's composite and keeps a pixel as water if it was water in at least half of its observed months. This is the same rule as the JRC reference used for training and assessment, so the map and the reference now define open water in the same way. Each training composite is labelled with JRC's map of its own month instead of the season.

Tested as below (1,000 points per map class, against the JRC monthly reference; 2005 is not a training year):

| Map overall accuracy | Urmia 2005 | Urmia 2020 | Loktak 2005 | Loktak 2020 |
|---|---|---|---|---|
| v1.2.0, seasonal composite | 0.994 | 0.990 | 0.972 | 0.963 |
| **v1.3.0, monthly maps + water frequency** | **0.996** | **0.990** | **0.983** | **0.963** |

- The largest gain is where water changes within the season. At Loktak Lake in 2005, the producer's accuracy for water rose from 0.58 to 0.97 and the allocation disagreement fell from 0.014 to 0.004: the seasonal composite had missed 42 % of the water there.
- At Lake Urmia, the differences are within the 95 % confidence intervals. The 2005 map improved slightly (quantity disagreement 0.005 → 0.003). In 2020 the overall accuracy is unchanged; the new map's water is more reliable (user's accuracy 0.988 → 0.996) but it misses a little more water (quantity disagreement 0.005 → 0.008).
- With the default script, the 2020 map of Lake Urmia has an overall accuracy of 0.993 ± 0.009 (250 points per class, 30 m; version 1.2.0: 0.991), with quantity and allocation disagreement of 0.005 and 0.002.
- The open-water area of Lake Urmia in summer 2025 is 421 km² (version 1.2.0: 520 km²). A pixel now has to be water in at least half of its observed months (two of three when all three months are clear); pixels with water in only one month still appear in the water-frequency band.
- The water probability is the Random Forest's vote share. A month is water when at least half of the trees vote water, which is what the class output of version 1.2.0 did, so this adds an uncertainty layer without changing the rule.

### Version 1.2.0: training data

Version 1.2.0 changed the training data after a comparison of model variants on both examples. Each variant was trained and then assessed as described above, against the JRC monthly reference, with 1,000 points per map class (Lake Urmia at 60 m, Loktak Lake at 30 m). 2005 is not a training year, so it tests whether the model carries over to other years and sensors. The 95 % confidence intervals are about ±0.003 to ±0.013.

| Variant (map overall accuracy) | Urmia 2005 | Urmia 2020 | Loktak 2005 | Loktak 2020 |
|---|---|---|---|---|
| v1.1: trained on 2020 only, JRC permanent water vs. never water, 8 indices | 0.990 | 0.984 | 0.941 | 0.942 |
| v1.1 with Landsat 5/7 harmonized to Landsat 8 (Roy et al., 2016) | 0.931 | 0.981 | 0.964 | 0.942 |
| Four training years, season-matched labels in four strata, 8 indices | 0.994 | 0.991 | 0.967 | 0.959 |
| **Same, plus the six reflectance bands (v1.2.0 default)** | **0.994** | **0.990** | **0.972** | **0.963** |
| Same, plus HAND and slope from MERIT Hydro | 0.994 | 0.989 | 0.972 | 0.965 |

- **Training data mattered most.** At Loktak Lake, v1.1 mapped 73.7 km² of water in 2020 where the area-adjusted estimate was 55.8 km² (quantity disagreement 0.042). With v1.2.0 the two agree (57.1 and 56.9 km², quantity disagreement 0.0005), and the user's accuracy for water in 2005 rose from 0.45 to 0.81. Sampling shores, seasonal water and dry lake beds as strata of their own (following Yue et al., 2023, who sampled seasonal water separately) gave the model the hard cases it had not seen before.
- **Harmonization was not adopted.** It lowered the producer's accuracy for water in the Landsat 5/7 year 2005 from 0.998 to 0.80 at Lake Urmia and from 0.73 to 0.31 at Loktak Lake (there the overall accuracy rose only because water is a small share of the area). The regression adds a fixed offset (0.041 in NIR, 0.025 in SWIR1) that brightens dark water. Training on years from all sensors removed the sensor problem instead.
- **Terrain inputs and a larger minimum leaf size** (`minLeafPopulation` 5) gave no consistent gain for these two lakes, which lie on flat ground. They may still help in mountains, where shadows are mistaken for water.
- With the default script, the 2020 map of Lake Urmia has an overall accuracy of 0.991 ± 0.009 (250 points per class, 30 m), with quantity and allocation disagreement of 0.003 and 0.006. The hold-out check is now 0.983 instead of 0.993, because the hard cases are part of it.
- The open-water area of Lake Urmia in summer 2025 drops from 687 km² (v1.1) to 520 km² (v1.2.0): the new model no longer counts the bright, very shallow margins over the salt crust as open water, in line with JRC.

All numbers measure agreement with JRC Global Surface Water, not with ground truth.

## Coverage in the examples

| | Lake Urmia | Loktak Lake |
|---|---|---|
| Share of the ROI in the 2020 sampling frame | 0.99 | 0.82 |
| Cloud and cloud-shadow share of all observations, 2025 | 3.9 % | 83.3 % |
| Series years flagged for coverage (of 9) | 0 | 7 |

Loktak Lake is partly covered by floating vegetation (phumdis). In the July–September monsoon, 67–89 % of the observations are cloud or cloud shadow. 1985 and 1995 have no Landsat scene in the season at all, 1990 has only scenes above the 60 % cloud limit, and 2000–2020 are 50–82 % observed, so only 2005 and 2025 pass the 95 % coverage check. Without the coverage columns, those years would look like years with little or no water.

To run the second example, set `roi: EXAMPLES.loktak`.

## Configuration

| Parameter | Default | Description |
|---|---|---|
| `roi` | `EXAMPLES.urmia` | Area to classify: `EXAMPLES.urmia`, `EXAMPLES.loktak`, a drawn geometry or an asset |
| `year` | `2025` | Year to map |
| `season` | `['07-01', '09-30']` | Month-day window of the composite (within one calendar year; the script stops with a message otherwise) |
| `maxSceneCloud` | `60` | Scenes above this cloud cover (%) are skipped |
| `useLandsat7` | `true` | Include Landsat 7 (gaps after 2003 are filled by the median where other sensors exist) |
| `mapping` | `'monthly'` | `'monthly'`: classify each month and keep water seen in at least half of the observed months; `'seasonal'`: one composite of the whole season (version 1.2.0) |
| `trainingSource` | `'auto'` | `'auto'` (JRC labels) or `'drawn'` (your `water` / `land` layers) |
| `trainYears` | `[1990, 2000, 2010, 2020]` | Label years for `'auto'` (1984–2021) |
| `samplesPerClass` | `1000` | Water and land training points each, over all `trainYears` |
| `features` | 6 bands + 8 indices | Inputs to the classifier |
| `nTrees` | `100` | Number of trees |
| `trainFraction` | `0.7` | Share of blocks used for training; the rest is the hold-out |
| `blockSize` | `2000` | Block edge (m) for the training / hold-out split; `0` splits point by point |
| `assessment.year` | `2020` | Map to assess (1984–2021 with the JRC reference) |
| `assessment.pointsPerClass` | `[250, 250]` | Points in mapped land and mapped water |
| `assessment.referencePoints` | `null` | Asset ID of your own labelled points (optional) |
| `seriesYears` | 1985–2025 every 5 years | Years for the area series (`[]` to skip) |
| `areaScale` | `60` | Scale (m) for the area sums of the series |
| `minObservedFraction` | `0.95` | Years with less of the ROI observed are flagged and left out of the chart |

## Outputs

- `wetland_water_rf_<year>.tif`: three bands at 30 m: water (1 = water, 0 = not water), water frequency (% of the observed months that were water) and water probability (mean % of trees voting water); 255 = never observed.
- `wetland_water_rf_map_accuracy.csv`: per class (`land`, `water`): mapped and area-adjusted km² with 95 % CI, user's and producer's accuracy with 95 % CI, number of points; one `overall` row with overall accuracy and CI, quantity and allocation disagreement, sampling-frame area and share of the ROI.
- `wetland_water_rf_assessment_points_<year>.csv`: `lon`, `lat`, `map`, `reference` for every assessment point.
- `wetland_water_rf_holdout.csv`: hold-out overall accuracy, kappa, per-class accuracies, sample counts, block size and the importance of each index.
- `wetland_water_rf_area_series.csv`: `year`, `water_km2`, `observed_km2`, `observed_frac`, `cloud_pct`, `low_coverage` (1 = below `minObservedFraction`), `n_scenes`.

## Notes

- With `'monthly'`, a month with no clear scene is simply not counted, so a pixel needs only one clear month to be mapped. `water_frequency` is the share of the observed months, not of all months: 0.5 from two observed months is less certain than 0.5 from six.
- The model is trained once and applied to every year, so all years are classified the same way. The map accuracy is estimated for `assessment.year` only; other years use the same model and processing, but their accuracy is not measured.
- `observed_km2` is the part of the ROI with at least one clear observation in the composite. A flagged year's `water_km2` covers only the observed part, so it is not comparable with the other years.
- `cloud_pct` is the share of all observations of the ROI in the season that Landsat's QA band marks as cloud, dilated cloud or cloud shadow. It counts every scene of the season, also those skipped by `maxSceneCloud`, so it shows how cloudy the season was. It is empty when the season has no scene at all. `n_scenes` counts only the scenes used in the composite.
- With `'auto'`, labels come from the JRC monthly history, so the map follows JRC's definition of open water. Your own samples are better for turbid, saline or vegetated water. Landsat does not see water under vegetation.
- Large regions: raise `areaScale` or `tileScale` if you hit memory limits. The assessment sums run at 30 m.
- `'monthly'` classifies one composite per month instead of one per season (three times as many with the default July–September season), so the Console needs longer, above all for the area series. If it is slow, run the series from the **Tasks** tab (`wetland_water_rf_area_series.csv`), shorten `seriesYears`, or use `mapping: 'seasonal'` for a quick first look.

## Data

- Landsat Collection 2 Level-2: [`LANDSAT/LT05/C02/T1_L2`](https://developers.google.com/earth-engine/datasets/catalog/LANDSAT_LT05_C02_T1_L2), [`LE07`](https://developers.google.com/earth-engine/datasets/catalog/LANDSAT_LE07_C02_T1_L2), [`LC08`](https://developers.google.com/earth-engine/datasets/catalog/LANDSAT_LC08_C02_T1_L2), [`LC09`](https://developers.google.com/earth-engine/datasets/catalog/LANDSAT_LC09_C02_T1_L2)
- JRC Global Surface Water yearly and monthly history: [`JRC/GSW1_4/YearlyHistory`](https://developers.google.com/earth-engine/datasets/catalog/JRC_GSW1_4_YearlyHistory), [`JRC/GSW1_4/MonthlyHistory`](https://developers.google.com/earth-engine/datasets/catalog/JRC_GSW1_4_MonthlyHistory) (Pekel et al., 2016)

## References

- Mueller, N., Lewis, A., Roberts, D., Ring, S., Melrose, R., Sixsmith, J., Lymburner, L., McIntyre, A., Tan, P., Curnow, S., & Ip, A. (2016). Water observations from space: Mapping surface water from 25 years of Landsat imagery across Australia. *Remote Sensing of Environment*, 174, 341–352. https://doi.org/10.1016/j.rse.2015.11.003
- Olofsson, P., Foody, G. M., Herold, M., Stehman, S. V., Woodcock, C. E., & Wulder, M. A. (2014). Good practices for estimating area and assessing accuracy of land change. *Remote Sensing of Environment*, 148, 42–57. https://doi.org/10.1016/j.rse.2014.02.015
- Pekel, J.-F., Cottam, A., Gorelick, N., & Belward, A. S. (2016). High-resolution mapping of global surface water and its long-term changes. *Nature*, 540, 418–422. https://doi.org/10.1038/nature20584
- Pickens, A. H., Hansen, M. C., Hancher, M., Stehman, S. V., Tyukavina, A., Potapov, P., Marroquin, B., & Sherani, Z. (2020). Mapping and sampling to characterize global inland water dynamics from 1999 to 2018 with full Landsat time-series. *Remote Sensing of Environment*, 243, 111792. https://doi.org/10.1016/j.rse.2020.111792
- Pontius, R. G., & Millones, M. (2011). Death to Kappa: birth of quantity disagreement and allocation disagreement for accuracy assessment. *International Journal of Remote Sensing*, 32(15), 4407–4429. https://doi.org/10.1080/01431161.2011.552923
- Roy, D. P., Kovalskyy, V., Zhang, H. K., Vermote, E. F., Yan, L., Kumar, S. S., & Egorov, A. (2016). Characterization of Landsat-7 to Landsat-8 reflective wavelength and normalized difference vegetation index continuity. *Remote Sensing of Environment*, 185, 57–70. https://doi.org/10.1016/j.rse.2015.12.024
- Wadoux, A. M. J.-C., Heuvelink, G. B. M., de Bruin, S., & Brus, D. J. (2021). Spatial cross-validation is not the right way to evaluate map accuracy. *Ecological Modelling*, 457, 109692. https://doi.org/10.1016/j.ecolmodel.2021.109692
- Yue, L., Li, B., Zhu, S., Yuan, Q., & Shen, H. (2023). A fully automatic and high-accuracy surface water mapping framework on Google Earth Engine using Landsat time-series. *International Journal of Digital Earth*. https://doi.org/10.1080/17538947.2023.2166606

## Changelog

- **1.3.0** (2026-11-23): each month of the season is classified on its own and a pixel is water if it was water in at least half of its observed months, the same rule as the JRC reference (`mapping: 'monthly'`, new default; `'seasonal'` keeps version 1.2.0); `'auto'` training composites labelled with JRC's map of the same month; water frequency and water probability added to the map and the GeoTIFF. Map accuracy rose or stayed the same in all four tests, most at Loktak Lake in 2005 (see Model tests).
- **1.2.0** (2026-11-20): `'auto'` training labels from the JRC monthly history of the composite's months in four years (1990, 2000, 2010, 2020), sampled in four strata that include shores, seasonal water and dry lake beds; the six reflectance bands added to the inputs. Map accuracy rose in both examples and the water-area bias at Loktak Lake almost disappeared (see Model tests).
- **1.1.0** (2026-11-18): area-adjusted map accuracy and area estimates with 95 % CIs (Olofsson et al., 2014); quantity and allocation disagreement (Pontius & Millones, 2011); spatially blocked hold-out; observed area, observed share, cloud percentage and a low-coverage flag in the area series; a second, small and cloudy example (Loktak Lake); assessment points exported for relabelling.
- **1.0.0** (2026-10-25): first release.

## Cite this tool

Abbasalizadehrezaei, P. (2026). *Wetland Water Mapping with Random Forest* (Version 1.3.0) [Software]. Zenodo. https://doi.org/10.5281/zenodo.23646350

GitHub also offers a ready-made citation under **Cite this repository** (from [CITATION.cff](CITATION.cff)).

## Author

**Parisa Abbasalizadehrezaei** · [risarezaei.github.io](https://risarezaei.github.io)

Released under the [MIT License](LICENSE).
