try {
  require('onnxruntime-node');
  console.log('ONNX_CARREGA_NO_ALPINE');
} catch (e) {
  console.log('FALHA:', e.message.split('\n')[0]);
}
