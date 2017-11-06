// @flow

const ajax = require('../util/ajax');
const rewind = require('geojson-rewind');
const GeoJSONWrapper = require('./geojson_wrapper');
const vtpbf = require('vt-pbf');
const supercluster = require('supercluster');
const geojsonvt = require('geojson-vt');

const VectorTileWorkerSource = require('./vector_tile_worker_source');

import type {
    WorkerTileParameters,
    WorkerTileCallback,
} from '../source/worker_source';

import type Actor from '../util/actor';
import type StyleLayerIndex from '../style/style_layer_index';

import type {LoadVectorDataCallback} from './vector_tile_worker_source';
import type {RequestParameters} from '../util/ajax';

export type GeoJSON = Object;

export type LoadGeoJSONParameters = {
    request?: RequestParameters,
    data?: string,
    source: string,
    superclusterOptions?: Object,
    geojsonVtOptions?: Object
};

export type getPointListDataParameters = {
    bounds: Object,
    zoom: number,
    maxCount?: number,
    source: string,
    minzoom: number,
    maxzoom: number
};

export type LoadGeoJSON = (params: LoadGeoJSONParameters, callback: Callback<mixed>) => void;

export interface GeoJSONIndex {
}

function loadGeoJSONTile(params: WorkerTileParameters, callback: LoadVectorDataCallback) {
    const source = params.source,
        coord = params.coord;

    if (!this._geoJSONIndexes[source]) {
        return callback(null, null);  // we couldn't load the file
    }

    const geoJSONTile = this._geoJSONIndexes[source].getTile(Math.min(coord.z, params.maxZoom), coord.x, coord.y);
    if (!geoJSONTile) {
        return callback(null, null); // nothing in the given tile
    }

    const geojsonWrapper = new GeoJSONWrapper(geoJSONTile.features);

    // Encode the geojson-vt tile into binary vector tile form form.  This
    // is a convenience that allows `FeatureIndex` to operate the same way
    // across `VectorTileSource` and `GeoJSONSource` data.
    let pbf = vtpbf(geojsonWrapper);
    if (pbf.byteOffset !== 0 || pbf.byteLength !== pbf.buffer.byteLength) {
        // Compatibility with node Buffer (https://github.com/mapbox/pbf/issues/35)
        pbf = new Uint8Array(pbf);
    }

    callback(null, {
        vectorTile: geojsonWrapper,
        rawData: pbf.buffer
    });
}

/**
 * The {@link WorkerSource} implementation that supports {@link GeoJSONSource}.
 * This class is designed to be easily reused to support custom source types
 * for data formats that can be parsed/converted into an in-memory GeoJSON
 * representation.  To do so, create it with
 * `new GeoJSONWorkerSource(actor, layerIndex, customLoadGeoJSONFunction)`.
 * For a full example, see [mapbox-gl-topojson](https://github.com/developmentseed/mapbox-gl-topojson).
 *
 * @private
 */
class GeoJSONWorkerSource extends VectorTileWorkerSource {
    _geoJSONIndexes: { [string]: GeoJSONIndex };
    loadGeoJSON: LoadGeoJSON;

    /**
     * @param [loadGeoJSON] Optional method for custom loading/parsing of
     * GeoJSON based on parameters passed from the main-thread Source.
     * See {@link GeoJSONWorkerSource#loadGeoJSON}.
     */
    constructor(actor: Actor, layerIndex: StyleLayerIndex, loadGeoJSON: ?LoadGeoJSON) {
        super(actor, layerIndex, loadGeoJSONTile);
        if (loadGeoJSON) {
            this.loadGeoJSON = loadGeoJSON;
        }
        // object mapping source ids to geojson-vt-like tile indexes
        this._geoJSONIndexes = {};
    }

    /**
     * Fetches (if appropriate), parses, and index geojson data into tiles. This
     * preparatory method must be called before {@link GeoJSONWorkerSource#loadTile}
     * can correctly serve up tiles.
     *
     * Defers to {@link GeoJSONWorkerSource#loadGeoJSON} for the fetching/parsing,
     * expecting `callback(error, data)` to be called with either an error or a
     * parsed GeoJSON object.
     * @param params
     * @param params.source The id of the source.
     * @param callback
     */
    loadData(params: LoadGeoJSONParameters, callback: Callback<void>) {
        this.loadGeoJSON(params, (err, data) => {
            if (err || !data) {
                return callback(err);
            } else if (typeof data !== 'object') {
                return callback(new Error("Input data is not a valid GeoJSON object."));
            } else {
                rewind(data, true);

                try {
                    this._geoJSONIndexes[params.source] = params.cluster ?
                        supercluster(params.superclusterOptions).load(data.features) :
                        geojsonvt(data, params.geojsonVtOptions);
                } catch (err) {
                    return callback(err);
                }

                this.loaded[params.source] = {};
                callback(null);
            }
        });
    }
    
    getPointListData(params: getPointListDataParameters, callback: Callback<void>) {
      let result = {
        apartmentIds: [],
        clusterLookup: {}
      };
      
      if(typeof this._geoJSONIndexes[params.source] === 'undefined') {
        return callback(null, result);
      }
      let supercluster = this._geoJSONIndexes[params.source];
      

      //TODO: remove this duck-typing check
      if(typeof supercluster.getClusters === 'undefined') {
        return callback(null, JSON.stringify(result));
      }
      let zoom = Math.max(Math.min(Math.floor(params.zoom), params.maxzoom), params.minzoom);
      let maxCount = params.maxCount || Infinity;
      let bounds = params.bounds;
      let center = params.center || this.getBboxArrCenter(bounds);

      let clusters = supercluster.getClusters(
        bounds,
        zoom
      );

      let apartmentClusterLookup = {};
      let apartmentIds = [];
      let allClustersData = [];
      let apartmentsCnt = 0;
      
      for (let cluster of clusters) {
        if (
          typeof cluster.properties !== 'object' ||
          cluster.properties.cluster !== true
        ) {
          var clusterFeatures = [cluster];
          var clusterId = cluster.i;
        } else {
          var clusterId = cluster.properties.cluster_id;
          var clusterFeatures = supercluster.getLeaves(
            clusterId,
            zoom,
            maxCount
          );
        }

        let allClusterData = {
          clusterId,
          coordinates: clusterFeatures[0].geometry.coordinates,
          apartmentIds: [],
        };
        for (let clusterFeature of clusterFeatures) {
          allClusterData.apartmentIds.push(clusterFeature.i);
          apartmentsCnt++;
          if(apartmentsCnt >= maxCount) {
            break;
          }
        }
        
        allClustersData.push(allClusterData);
        if(apartmentsCnt >= maxCount) {
            break;
        }
      }

      this.geoSpiralSort(allClustersData, center);

      for (let allClusterData of allClustersData) {
        for (let apartmentId of allClusterData.apartmentIds) {
          apartmentIds.push(apartmentId);
          apartmentClusterLookup[apartmentId] = allClusterData.clusterId;
        }
      }

      result.apartmentIds = apartmentIds;
      result.clusterLookup = apartmentClusterLookup;
      return callback(null, result);
    }
    
    
    getBboxArrCenter(bbox) {
      return [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
    }

    geoSpiralSort(allClustersData, center) {
      if (!allClustersData.length) {
        return;
      }
      
      for (let allClusterData of allClustersData) {
        allClusterData.distance = this.calculateDistarnce(
          center,
          allClusterData.coordinates
        );
      }
      allClustersData.sort((a, b) => {
        return a.distance - b.distance;
      });
    }

    calculateDistarnce(a, b) {
      var p = 0.017453292519943295; // Math.PI / 180
      var c = Math.cos;
      var a =
        0.5 -
        c((b[1] - a[1]) * p) / 2 +
        c(a[1] * p) * c(b[1] * p) * (1 - c((b[0] - a[0]) * p)) / 2;

      return 12742 * Math.asin(Math.sqrt(a)); // 2 * R; R = 6371 km
    }

    /**
    * Implements {@link WorkerSource#reloadTile}.
    *
    * If the tile is loaded, uses the implementation in VectorTileWorkerSource.
    * Otherwise, such as after a setData() call, we load the tile fresh.
    *
    * @param params
    * @param params.source The id of the source for which we're loading this tile.
    * @param params.uid The UID for this tile.
    */
    reloadTile(params: WorkerTileParameters, callback: WorkerTileCallback) {
        const loaded = this.loaded[params.source],
            uid = params.uid;

        if (loaded && loaded[uid]) {
            return super.reloadTile(params, callback);
        } else {
            return this.loadTile(params, callback);
        }
    }

    /**
     * Fetch and parse GeoJSON according to the given params.  Calls `callback`
     * with `(err, data)`, where `data` is a parsed GeoJSON object.
     *
     * GeoJSON is loaded and parsed from `params.url` if it exists, or else
     * expected as a literal (string or object) `params.data`.
     *
     * @param params
     * @param [params.url] A URL to the remote GeoJSON data.
     * @param [params.data] Literal GeoJSON data. Must be provided if `params.url` is not.
     */
    loadGeoJSON(params: LoadGeoJSONParameters, callback: Callback<mixed>) {
        // Because of same origin issues, urls must either include an explicit
        // origin or absolute path.
        // ie: /foo/bar.json or http://example.com/bar.json
        // but not ../foo/bar.json
        if (params.request) {
            ajax.getJSON(params.request, callback);
        } else if (typeof params.data === 'string') {
            try {
                return callback(null, JSON.parse(params.data));
            } catch (e) {
                return callback(new Error("Input data is not a valid GeoJSON object."));
            }
        } else {
            return callback(new Error("Input data is not a valid GeoJSON object."));
        }
    }

    removeSource(params: {source: string}, callback: Callback<mixed>) {
        if (this._geoJSONIndexes[params.source]) {
            delete this._geoJSONIndexes[params.source];
        }
        callback();
    }
}

module.exports = GeoJSONWorkerSource;
