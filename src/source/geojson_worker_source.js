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
import type { Callback } from '../types/callback';

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
    maxzoom: number,
    travellingSalesmanApprox?: boolean
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
        }
        
        allClustersData.push(allClusterData);
        if(apartmentsCnt >= maxCount) {
            break;
        }
      }
      
      this.distanceSort(allClustersData, center);
      
      if(params.travellingSalesmanApprox) {
     
        let points = new Array(allClustersData.length);
        for(let i=0; i<allClustersData.length; i++) {
          var allClusterData = allClustersData[i];
          points[i] = allClusterData.coordinates;
        }

        let travellingSalesmanApproximation = new TravellingSalesmanApproximation(points, center);
        let paths = travellingSalesmanApproximation.solve()[0];

        var allClustersDataSorted = new Array(allClustersData.length);
        for(let i=0; i<paths.length; i++) {
          allClustersDataSorted[i] = allClustersData[paths[i]];
        }
      
      } else {
        allClustersDataSorted = allClustersData;
      }

      for (let allClusterData of allClustersDataSorted) {
        for (let apartmentId of allClusterData.apartmentIds) {
          apartmentIds.push(apartmentId);
          apartmentClusterLookup[apartmentId] = allClusterData.clusterId;
        }
      }

      result.apartmentIds = apartmentIds;
      result.clusterLookup = apartmentClusterLookup;
      return callback(null, result);
    }
    
    distanceSort(allClustersData, center) {
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
      return Math.pow(a[0]-b[0], 2) + Math.pow(a[1]-b[1], 2);
    }
    
    
    getBboxArrCenter(bbox) {
      return [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
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


class TravellingSalesmanApproximation {
  constructor(points, center) {
    this.xPos = 0;
    this.yPos = 1;
    this.distancePos = 2;
    this.bounds = {
      minX: null,
      minY: null,
      maxX: null,
      maxY: null,
    };
    
    let pointsClone = new Array(points.length);
    for(let i=0; i<points.length; i++) {
      pointsClone[i] = points[i].slice();
    }
    
    this.normalizePoints(pointsClone);
    this.center = new Array(2);
    if(!center) {
      this.center[this.xPos] = this.width/2;
      this.center[this.yPos] = this.height/2;
    } else {
      this.center[this.xPos] =
              (center[this.xPos] - this.bounds.minX) *
              this.width /
              (this.bounds.maxX - this.bounds.minX);
      this.center[this.yPos] =
              (center[this.yPos] - this.bounds.minY) *
              this.height /
              (this.bounds.maxY - this.bounds.minY);
    }

    this.distanceMatrix = [];
    this.randomPath = [];
    this.generateDistanceMatrix();
    this.generateRandomPath();
  }
  
  getPoints(width, height) {
    var points = new Array(this.points.length);
    for (var i = 0; i < points.length; i++) {
      points[i] = {
        x:
              (this.points[i][this.xPos]) *
              width /
              this.width,
        y:
              height - this.points[i][this.yPos]*
              height /
              this.height
      }
    }
    return points;
  }

  generateDistanceMatrix() {
    var points = this.points;
    var pointsCount = this.points.length;
    var distanceMatrix = new Array(pointsCount);
    for (var i = 0; i < pointsCount; i++) {
      distanceMatrix[i] = new Array(pointsCount);
    }

    for (var i = 0; i < pointsCount; i++) {
      for (var j = i; j < pointsCount; j++) {
        distanceMatrix[i][j] = Math.sqrt((points[i][this.xPos] - points[j][this.xPos]) * (points[i][this.xPos]
                - points[j][this.xPos]) + (points[i][this.yPos] - points[j][this.yPos]) * (points[i][this.yPos] - points[j][this.yPos]));
        distanceMatrix[j][i] = distanceMatrix[i][j];
      }
    }
    this.distanceMatrix = distanceMatrix;
  }

  normalizePoints(points) {
    
    for (var i = 0; i < points.length; i++) {
      let point = points[i];
      
      var polygonY = point[this.yPos];
      var polygonX = point[this.xPos];
      if (polygonX > this.bounds.maxX || this.bounds.maxX === null) {
        this.bounds.maxX = polygonX;
      }
      if (polygonX < this.bounds.minX || this.bounds.minX === null) {
        this.bounds.minX = polygonX;
      }

      if (polygonY > this.bounds.maxY || this.bounds.maxY === null) {
        this.bounds.maxY = polygonY;
      }
      if (polygonY < this.bounds.minY || this.bounds.minY === null) {
        this.bounds.minY = polygonY;
      }
    }
    this.height = this.bounds.maxY - this.bounds.minY;
    this.width = this.bounds.maxX - this.bounds.minX;
    for (var i = 0; i < points.length; i++) {
      let point = points[i];
      
      point[this.xPos] =
              (point[this.xPos] - this.bounds.minX) *
              this.width /
              (this.bounds.maxX - this.bounds.minX);
      point[this.yPos] =
              (point[this.yPos] - this.bounds.minY) *
              this.height /
              (this.bounds.maxY - this.bounds.minY);
    }
    this.points = points;
  }

  generateRandomPath() {
    var path = [];
    for (var i = 0; i < this.points.length; i++) {
      path[i] = i;
    }
    this.randomPath = path;
  }

  solve() {
    var remaining = this.randomPath;
    var path = [remaining[0]];
    var paths = [];
    paths.push(path.slice(0));

    for (var i = 1; i < this.points.length; i++) {
      var indexInRemaining = 0;
      var indexInPath = 0;
      var minimalDistance = this.height * this.height + this.width * this.width + 1;
      var maximalDistanceToTour = -1;
      var bestPoint = null;

      for (var j = i; j < this.points.length; j++) {

        minimalDistance = this.height * this.height + this.width * this.width + 1;

        for (var k = 0; k < path.length; k++) {
          var currentDistance = this.distanceMatrix[path[k]][remaining[j]];
          if (currentDistance < minimalDistance) {
            minimalDistance = currentDistance;

          }
        }
        if (minimalDistance > maximalDistanceToTour) {
          if (minimalDistance > maximalDistanceToTour) {
            maximalDistanceToTour = minimalDistance;
            bestPoint = remaining[j];
            indexInRemaining = j;
          }
        }

      }

      remaining = this.swap(remaining, indexInRemaining, i);

      var smallestDetour = this.height * this.height + this.width * this.width + 1;
      for (var k = 0; k < path.length - 1; k++) {
        var currentDetour = this.detour(path[k], remaining[i], path[k + 1]);
        if (currentDetour < smallestDetour) {
          smallestDetour = currentDetour;
          indexInPath = k;
        }
      }
      if (this.detour(path[path.length - 1], remaining[i], path[0]) < smallestDetour) {
        path.splice(path.length, 0, remaining[i]);
      } else {
        path.splice(indexInPath + 1, 0, remaining[i]);
      }
    }
    paths = [path];
    return paths;
  }

  swap(path, i, j) {
    var clone = path.slice(0);
    var temp = clone[i];
    clone[i] = clone[j];
    clone[j] = temp;
    return clone;
  }

  detour(before, insert, after) {
    return this.distanceMatrix[before][insert] + this.distanceMatrix[insert][after] - this.distanceMatrix[before][after];
  }
}

module.exports = GeoJSONWorkerSource;
