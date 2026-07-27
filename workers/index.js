'use strict';

const startWorkers = () => {
  console.log('Workers ready');
};

const stopWorkers = async () => {
  console.log('Workers stopped');
};

module.exports = { startWorkers, stopWorkers };
