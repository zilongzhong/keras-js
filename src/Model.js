import Promise from 'bluebird';
import toPairs from 'lodash/toPairs';
import mapKeys from 'lodash/mapKeys';
import camelCase from 'lodash/camelCase';
import find from 'lodash/find';
import keys from 'lodash/keys';
import values from 'lodash/values';
import sum from 'lodash/sum';
import isEqual from 'lodash/isEqual';
import every from 'lodash/every';
import * as layers from './layers';
import Tensor from './Tensor';

/**
 * Model class
 */
export default class Model {
  /**
   * create new Model class
   * @param {object} config.filepaths
   * @param {string} config.filepaths.modelFilepath - path to model architecture configuration (json)
   * @param {string} config.filepaths.weightsFilepath - path to weights data (arraybuffer)
   * @param {string} config.filepaths.metadataFilepath - path to weights metadata (json)
   * @param {object} [config.headers] - any additional HTTP headers required for resource fetching
   * @param {boolean} [config.gpu] - enable GPU
   * @param {boolean} [config.pipeline] - configure capable layers to run in pipeline mode (gpu must be enabled)
   * @param {boolean} [config.layerCallPauses] - force next tick after each layer call
   */
  constructor(config = {}) {
    const {
      filepaths = {},
      headers = {},
      gpu = false,
      pipeline = false,
      layerCallPauses = false
    } = config;

    if (!filepaths.model || !filepaths.weights || !filepaths.metadata) {
      throw new Error(
        'File paths must be declared for model, weights, and metadata.'
      );
    }
    this.filepaths = filepaths;
    this.filetypes = {
      model: 'json',
      weights: 'arraybuffer',
      metadata: 'json'
    };

    // HTTP(S) headers used during data fetching
    this.headers = headers;

    // flag to enable GPU where possible
    this.gpu = gpu;
    // flag to enable GPU pipeline mode where possible
    this.pipeline = pipeline;
    // flag to enable 0 ms pauses after layer computation calls
    this.layerCallPauses = layerCallPauses;

    this.data = {
      // object representing the model architecture configuration,
      // directly from the to_json() method in Keras
      model: {},
      // ArrayBuffer of all the weights, sequentially concatenated
      // see encoder.py for construction details - essentially the raw flattened
      // numerical data from the HDF5 file is extracted sequentially and concatenated.
      weights: null,
      // array of weight tensor metadata, used to reconstruct tensors from the raw
      // weights ArrayBuffer above.
      metadata: []
    };

    // keep track of XHR requests
    this.xhrs = { model: null, weights: null, metadata: null };

    // XHR progress
    this.xhrProgress = { model: 0, weights: 0, metadata: 0 };

    // map of model layers
    this.modelLayersMap = new Map();

    // array of model layer names with result
    this.layersWithResults = [];

    // directed acyclic graph of model network
    this.modelDAG = {};

    // input tensors
    this.inputTensors = {};

    // Promise for when Model class is initialized
    this._ready = this._initialize();

    // flag while computations are being performed
    this.isRunning = false;
  }

  /**
   * Promise for when model data is loaded and layers are initialized.
   * @returns {Promise}
   */
  ready() {
    return this._ready;
  }

  /**
   * Cancels any existing XHR requests
   */
  _interrupt() {
    const dataTypes = [ 'model', 'weights', 'metdata' ];
    dataTypes.forEach(type => {
      if (this.xhrs[type]) {
        this.xhrs[type].abort();
        this.xhrs[type] = null;
      }
    });
  }

  /**
   * Model initialization
   * @returns {Promise}
   */
  _initialize() {
    const dataTypes = [ 'model', 'weights', 'metadata' ];
    return Promise
      .all(dataTypes.map(type => this._dataRequest(type, this.headers)))
      .then(() => {
        this._createLayers();
        return Promise.resolve();
      })
      .catch(err => {
        console.log(err);
        this._interrupt();
      });
  }

  /**
   * Makes XHR request
   * @async
   * @param {string} type - type of requested data, one of `model`, `weights`, or `metadata`.
   * @param {Object} [headers] - any XHR headers to be passed along with request
   * @returns {Promise}
   */
  _dataRequest(type, headers = {}) {
    return new Promise((resolve, reject) => {
      let xhr = new XMLHttpRequest();
      xhr.open('GET', this.filepaths[type], true);
      xhr.responseType = this.filetypes[type];
      for (const [ h, v ] of toPairs(headers)) {
        xhr.setRequestHeader(h, v);
      }
      xhr.onload = e => {
        this.data[type] = xhr.response;
        this.xhrs[type] = null;
        this.xhrProgress[type] = 100;
        resolve();
      };
      xhr.onprogress = e => {
        if (e.lengthComputable) {
          const percentComplete = Math.round(100 * e.loaded / e.total);
          this.xhrProgress[type] = percentComplete;
        }
      };
      xhr.onerror = e => reject(e);
      xhr.send(null);
      this.xhrs[type] = xhr;
    });
  }

  /**
   * Loading progress calculated from all the XHRs combined.
   * @returns {number} progress
   */
  getLoadingProgress() {
    const progressValues = values(this.xhrProgress);
    return Math.round(sum(progressValues) / progressValues.length);
  }

  /**
   * Toggle GPU mode on/off
   * Iterate through all layers and set `gpu` attribute
   * @param {boolean} mode - on/off
   */
  toggleGpu(mode) {
    if (typeof mode === 'undefined') {
      this.gpu = !this.gpu;
    } else {
      this.gpu = mode;
    }
    for (let layer of this.modelLayersMap.values()) {
      layer.toggleGpu(this.gpu);
    }
  }

  /**
   * Builds network layer DAG
   *
   * For Keras models of class Sequential, we still convert the list into DAG format
   * for straightforward interoperability with graph models. We must first create an
   * Input layer as the initial layer, however.
   *
   * For class Model, the network DAG is constructed from the configuration inbound
   * and outbound nodes.
   *
   * Layer constructors take an `attrs` object, which contain layer parameters among
   * other information. Note that in the Keras model config object variables are
   * in snake_case. We convert the variable names to camelCase here.
   */
  _createLayers() {
    const modelClass = this.data.model.class_name;

    let modelConfig = [];
    if (modelClass === 'Sequential') {
      modelConfig = this.data.model.config;
    } else if (modelClass === 'Model') {
      modelConfig = this.data.model.config.layers;
    }

    modelConfig.forEach((layerDef, index) => {
      const layerClass = layerDef.class_name;
      const layerConfig = layerDef.config;

      if (!(layerClass in layers)) {
        throw new Error(
          `Layer ${layerClass} specified in model configuration is not implemented!`
        );
      }

      // create InputLayer node for Sequential class (which is not explicitly defined in config)
      // create input tensor for InputLayer specified in Model class (layer itself created later)
      if (modelClass === 'Sequential' && index === 0) {
        const inputName = 'input';
        const inputShape = layerConfig.batch_input_shape.slice(1);
        const layer = new layers.InputLayer({
          name: inputName,
          shape: inputShape
        });
        this.modelLayersMap.set(inputName, layer);
        this.modelDAG[inputName] = {
          layerClass: 'InputLayer',
          name: inputName,
          inbound: [],
          outbound: []
        };
        this.inputTensors[inputName] = new Tensor([], inputShape);
      } else if (modelClass === 'Model' && layerClass === 'InputLayer') {
        const inputShape = layerConfig.batch_input_shape.slice(1);
        this.inputTensors[layerConfig.name] = new Tensor([], inputShape);
      }

      let layer;
      if (layerClass === 'Bidirectional' || layerClass === 'TimeDistributed') {
        // create wrapper layers
        let attrs = mapKeys(layerConfig, (v, k) => camelCase(k));
        const wrappedLayerConfig = layerConfig.layer.config;
        const wrappedLayerClass = layerConfig.layer.class_name;
        let wrappedLayerAttrs = mapKeys(
          wrappedLayerConfig,
          (v, k) => camelCase(k)
        );
        if ('activation' in wrappedLayerAttrs) {
          wrappedLayerAttrs.activation = camelCase(
            wrappedLayerAttrs.activation
          );
        }
        if ('innerActivation' in wrappedLayerAttrs) {
          wrappedLayerAttrs.innerActivation = camelCase(
            wrappedLayerAttrs.innerActivation
          );
        }
        wrappedLayerAttrs.gpu = this.gpu;

        layer = new layers[layerClass](
          Object.assign(attrs, {
            layer: new layers[wrappedLayerClass](wrappedLayerAttrs)
          })
        );
      } else {
        // create regular layers
        let attrs = mapKeys(layerConfig, (v, k) => camelCase(k));
        if ('activation' in attrs) {
          attrs.activation = camelCase(attrs.activation);
        }
        if ('innerActivation' in attrs) {
          attrs.innerActivation = camelCase(attrs.innerActivation);
        }
        attrs.gpu = this.gpu;
        attrs.pipeline = this.pipeline;

        layer = new layers[layerClass](attrs);
      }

      // layer weights
      let weightNames = [];
      if (layerClass === 'Bidirectional') {
        const forwardName = layerConfig.layer.config.name;
        const backwardName = forwardName.replace(/forward/, 'backward');
        const forwardWeightNames = layer.forwardLayer.params.map(
          param => `${forwardName}_${param}`
        );
        const backwardWeightNames = layer.backwardLayer.params.map(
          param => `${backwardName}_${param}`
        );
        weightNames = forwardWeightNames.concat(backwardWeightNames);
      } else if (layerClass === 'TimeDistributed') {
        weightNames = layer.layer.params.map(
          param => `${layerConfig.layer.config.name}_${param}`
        );
      } else {
        weightNames = layer.params.map(param => `${layerConfig.name}_${param}`);
      }
      if (weightNames && weightNames.length) {
        const weights = weightNames.map(weightName => {
          const paramMetadata = find(this.data.metadata, meta => {
            const weightRE = new RegExp(`^${weightName}`);
            return meta.layer_name === layerConfig.name &&
              weightRE.test(meta.weight_name);
          });
          if (!paramMetadata) {
            throw new Error(`[Model] error loading weights.`);
          }

          const { offset, length, shape } = paramMetadata;
          return new Tensor(
            new Float32Array(this.data.weights, offset, length),
            shape
          );
        });
        layer.setWeights(weights);
      }

      this.modelLayersMap.set(layerConfig.name, layer);
      this.modelDAG[layerConfig.name] = {
        layerClass,
        name: layerConfig.name,
        inbound: [],
        outbound: []
      };

      if (modelClass === 'Sequential') {
        if (index === 0) {
          const inputName = 'input';
          this.modelDAG[inputName].outbound.push(layerConfig.name);
          this.modelDAG[layerConfig.name].inbound.push(inputName);
        } else {
          const prevLayerConfig = modelConfig[index - 1].config;
          this.modelDAG[layerConfig.name].inbound.push(prevLayerConfig.name);
          this.modelDAG[prevLayerConfig.name].outbound.push(layerConfig.name);
        }
      } else if (modelClass === 'Model') {
        if (layerDef.inbound_nodes && layerDef.inbound_nodes.length) {
          layerDef.inbound_nodes[0].forEach(node => {
            const inboundLayerName = node[0];
            this.modelDAG[layerConfig.name].inbound.push(inboundLayerName);
            this.modelDAG[inboundLayerName].outbound.push(layerConfig.name);
          });
        }
      }
    });
  }

  /**
   * Runs .call() on Merge layer
   * @param {Layer} currentLayer
   * @param {Layer[]} inboundLayers
   * @param {boolean} copyBeforeCall
   * @returns {Tensor}
   */
  _mergeLayerCall(currentLayer, inboundLayers, copyBeforeCall) {
    let inputs = inboundLayers.map(layer => layer.result);
    const canRunInPipeline = inputs.every(x => x._fromPipeline);
    if (!canRunInPipeline || !currentLayer._pipelineEnabled) {
      // If currentLayer is not pipeline enabled, then all inbound results
      // must first be converted from weblas tensors to regular tensors, if
      // necessary.
      // If currentLayer is pipeline enabled, but not all inbound results are
      // from pipeline mode, then all must still be converted from weblas
      // tensors to regular tensors.
      inputs = inputs.map((x, i) => {
        if (x._fromPipeline) {
          // copy from weblas tensor into regular tensor
          return inboundLayers[i].transferFromPipeline(x);
        } else if (copyBeforeCall) {
          // make a copy of regular tensor
          return new Tensor(x.tensor.data, x.tensor.shape);
        }
        return x;
      });
    } else if (copyBeforeCall) {
      // If currentLayer is pipeline enabled, and all inbound results are from
      // pipeline mode as well, but there are sibling layer nodes that require
      // the same input(s) (thus copyBeforeCall is true), then we directly copy
      // the weblas tensors.
      inputs = inputs.map(x => {
        let xNew = new Tensor([], x.tensor.shape);
        xNew.copyFromWeblasTensor(x.weblasTensor);
        xNew._fromPipeline = true;
        xNew._actualShape = x._actualShape.slice();
        return xNew;
      });
    }

    return currentLayer.call(inputs);
  }

  /**
   * Runs .call() on regular layer
   * @param {Layer} currentLayer
   * @param {Layer} inboundLayer
   * @param {boolean} copyBeforeCall
   * @returns {Tensor}
   */
  _regularLayerCall(currentLayer, inboundLayer, copyBeforeCall) {
    let inboundLayerResult = inboundLayer.result;
    if (!inboundLayerResult._fromPipeline || !currentLayer._pipelineEnabled) {
      // If currentLayer is not pipeline enabled or inbound layer result is not
      // from pipeline mode, then result must first be converted from a weblas
      // tensor to a regular tensor, if necessary.
      if (inboundLayerResult._fromPipeline) {
        // copy from weblas tensor into regular tensor
        inboundLayerResult = inboundLayer.transferFromPipeline(
          inboundLayerResult
        );
      } else if (copyBeforeCall) {
        // make a copy of regular tensor
        inboundLayerResult = new Tensor(
          inboundLayerResult.tensor.data,
          inboundLayerResult.tensor.shape
        );
      }
    } else if (copyBeforeCall) {
      // If currentLayer is pipeline enabled, and prev layer result is from
      // pipeline mode as well, but there are sibling layer nodes that require
      // the same input (thus copyBeforeCall is true), then we directly copy
      // the weblas tensor.
      let xNew = new Tensor([], inboundLayerResult.tensor.shape);
      xNew.copyFromWeblasTensor(inboundLayerResult.weblasTensor);
      xNew._fromPipeline = true;
      xNew._actualShape = inboundLayerResult._actualShape.slice();
      inboundLayerResult = xNew;
    }

    return currentLayer.call(inboundLayerResult);
  }

  /**
   * Async function for recursively traversing the DAG
   * Graph object is stored in `this.modelDAG`, keyed by layer name.
   * Layers are retrieved from Map object `this.modelLayersMap`.
   * @async
   * @param {[]string} nodes - array of layer names
   * @returns {Promise.<boolean>}
   */
  async _traverseDAG(nodes) {
    if (nodes.length === 0) {
      // Stopping criterion:
      // an output node will have 0 outbound nodes.
      return true;
    } else if (nodes.length === 1) {
      // Where computational logic lives for a given layer node
      // - Makes sure results are available from inbound layer nodes
      // - Keeps generator going until results are available from inbound layer nodes
      //   (important for Merge layer nodes where multiple inbound nodes may
      //    complete asynchronously)
      // - Runs computation for current layer node: .call()
      // - Starts new generator function for outbound nodes
      const node = nodes[0];
      const { layerClass, inbound, outbound } = this.modelDAG[node];
      if (layerClass !== 'InputLayer') {
        let currentLayer = this.modelLayersMap.get(node);
        if (currentLayer.visited) {
          return false;
        }

        const inboundLayers = inbound.map(n => this.modelLayersMap.get(n));
        if (!every(inboundLayers.map(layer => layer.hasResult))) {
          return false;
        }

        const numSiblingNodes = inbound
          .map(n => this.modelDAG[n].outbound)
          .reduce((num, outbound) => num + outbound.length, 0);
        const copyBeforeCall = numSiblingNodes >= 1;
        currentLayer.result = layerClass === 'Merge'
          ? this._mergeLayerCall(currentLayer, inboundLayers, copyBeforeCall)
          : this._regularLayerCall(
            currentLayer,
            inboundLayers[0],
            copyBeforeCall
          );

        currentLayer.hasResult = true;
        currentLayer.visited = true;
        this.layersWithResults.push(currentLayer.name);
        if (this.layerCallPauses) {
          // temporarily pause 0 ms
          // useful for allowing DOM operations and other simultaneously running functions on the main thread
          await Promise.delay(0);
        }
      }
      await this._traverseDAG(outbound);
    } else {
      await Promise.all(nodes.map(node => this._traverseDAG([ node ])));
    }
  }

  /**
   * Predict
   * @async
   * @param {Object} inputData - object where the keys are the named inputs of the model,
   *                             and values the TypedArray numeric data
   * @returns {Promise.<Object>} - outputData object where the keys are the named outputs
   *                             of the model, and values the TypedArray numeric data
   */
  async predict(inputData) {
    this.isRunning = true;

    const inputNames = keys(this.inputTensors).sort();
    if (!isEqual(keys(inputData).sort(), inputNames)) {
      this.isRunning = false;
      throw new Error(
        `predict() must take an object where the keys are the named inputs of the model: ${inputNames}.`
      );
    }
    if (
      !every(
        inputNames,
        inputName => inputData[inputName] instanceof Float32Array
      )
    ) {
      this.isRunning = false;
      throw new Error(
        'predict() must take an object where the values are the flattened data as Float32Array.'
      );
    }

    // reset hasResult and visited flags in all layers
    this.layersWithResults = [];
    for (let layer of this.modelLayersMap.values()) {
      layer.hasResult = false;
      layer.visited = false;
    }

    // load data to input tensors
    inputNames.forEach(inputName => {
      let inputLayer = this.modelLayersMap.get(inputName);
      this.inputTensors[inputName].replaceTensorData(inputData[inputName]);
      inputLayer.result = inputLayer.call(this.inputTensors[inputName]);
      inputLayer.hasResult = true;
      inputLayer.visited = true;
    });

    // start traversing DAG at input
    await this._traverseDAG(inputNames);

    // outputs are layers with no outbound nodes
    const modelClass = this.data.model.class_name;
    if (modelClass === 'Sequential') {
      const outputLayer = find(
        values(this.modelDAG),
        node => !node.outbound.length
      );
      const { result } = this.modelLayersMap.get(outputLayer.name);
      const outputData = { output: result.tensor.data };
      this.isRunning = false;
      return outputData;
    } else if (modelClass === 'Model') {
      const outputLayers = values(this.modelDAG).filter(
        node => !node.outbound.length
      );
      let outputData = {};
      outputLayers.forEach(layer => {
        const { result } = this.modelLayersMap.get(layer.name);
        outputData[layer.name] = result.tensor.data;
      });
      this.isRunning = false;
      return outputData;
    }
  }
}
