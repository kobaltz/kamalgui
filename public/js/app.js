const containerData = {};
let refreshInterval = null;
const chartHistory = 10;
const colorPalette = [
  'rgba(54, 162, 235, 0.7)',
  'rgba(255, 99, 132, 0.7)',
  'rgba(255, 206, 86, 0.7)',
  'rgba(75, 192, 192, 0.7)',
  'rgba(153, 102, 255, 0.7)',
  'rgba(255, 159, 64, 0.7)',
];
let hideExitedContainers = true;
let containersInitialized = new Set();
let isRefreshing = false;
let pendingUpdates = new Map();
let containerStartTimes = {};

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('refresh-now').addEventListener('click', (e) => {
    e.preventDefault();
    refreshData();
  });

  document.getElementById('refresh-interval').addEventListener('change', updateRefreshInterval);

  const hideExitedCheckbox = document.getElementById('hide-exited');
  hideExitedCheckbox.checked = hideExitedContainers;
  hideExitedCheckbox.addEventListener('change', function () {
    hideExitedContainers = this.checked;
    refreshContainerVisibility();
  });

  updateRefreshInterval();

  refreshData();
});

function updateRefreshInterval() {
  const intervalSelect = document.getElementById('refresh-interval');
  const seconds = parseInt(intervalSelect.value, 10);

  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }

  if (seconds > 0) {
    refreshInterval = setInterval(() => {
      if (!isRefreshing) {
        refreshData();
      }
    }, seconds * 1000);
  }
}

async function refreshData() {
  if (isRefreshing) return;

  isRefreshing = true;

  try {
    const containers = await fetchWithTimeout('/api/containers/json?all=1');

    updateContainerList(containers);

    const runningContainers = containers
      .filter(container => container.State === 'running')
      .map(container => container.Id);

    await Promise.all(
      runningContainers.map(async (containerId) => {
        try {
          const containerInfo = await fetchWithTimeout(`/api/containers/${containerId}/json`);
          if (containerInfo && containerInfo.State && containerInfo.State.StartedAt) {
            containerStartTimes[containerId] = new Date(containerInfo.State.StartedAt).getTime();
          }
        } catch (error) {
          console.error(`Error fetching container info for ${containerId}:`, error);
        }
      })
    );

    if (runningContainers.length > 0) {
      await Promise.all(
        runningContainers.map(containerId =>
          fetchContainerStats(containerId)
        )
      );
    }
  } catch (error) {
    console.error('Error fetching container data:', error);
    if (error.name === 'AbortError') {
      console.log('Request timed out');
    } else {
      const containersList = document.getElementById('containers-list');
      if (!containersList.querySelector('.container-card')) {
        containersList.innerHTML = `
          <div class="col-span-full text-center text-red-500 py-12">
            Error loading containers: ${error.message}
          </div>
        `;
      }
    }
  } finally {
    isRefreshing = false;
  }
}

async function fetchWithTimeout(url, options = {}, timeout = 5000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'X-Requested-With': 'XMLHttpRequest',
        ...(options.headers || {})
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP error ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(id);
  }
}

function refreshContainerVisibility() {
  const containerCards = document.querySelectorAll('.container-card');

  containerCards.forEach(card => {
    if (hideExitedContainers && card.dataset.state === 'exited') {
      card.classList.add('hidden');
    } else {
      card.classList.remove('hidden');
    }
  });
}

async function fetchContainerStats(containerId) {
  try {
    if (pendingUpdates.has(containerId)) {
      const lastPending = pendingUpdates.get(containerId);
      if ((Date.now() - lastPending) < 2000) {
        return;
      }
    }

    pendingUpdates.set(containerId, Date.now());

    const stats = await fetchWithTimeout(`/api/containers/${containerId}/stats?stream=false`);
    processContainerStats(containerId, stats);
  } catch (error) {
    console.error(`Error fetching stats for container ${containerId}:`, error);
    pendingUpdates.delete(containerId);
  }
}

function processContainerStats(containerId, stats) {
  if (!stats || !stats.cpu_stats || !stats.memory_stats) {
    console.warn(`Received invalid stats for container ${containerId}`);
    return;
  }

  if (!containerData[containerId]) {
    containerData[containerId] = {
      cpuHistory: Array(chartHistory).fill(0),
      memoryHistory: Array(chartHistory).fill(0),
      networkRxHistory: Array(chartHistory).fill(0),
      networkTxHistory: Array(chartHistory).fill(0),
      diskReadHistory: Array(chartHistory).fill(0),
      diskWriteHistory: Array(chartHistory).fill(0),
      labels: Array(chartHistory).fill(''),
      lastStats: null
    };
  }

  const data = containerData[containerId];
  const lastStats = data.lastStats;

  const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - (stats.precpu_stats.cpu_usage?.total_usage || 0);
  const systemCpuDelta = stats.cpu_stats.system_cpu_usage - (stats.precpu_stats.system_cpu_usage || 0);
  const cpuCores = stats.cpu_stats.online_cpus || 1;

  let cpuPercent = 0;
  if (systemCpuDelta > 0 && cpuDelta > 0) {
    cpuPercent = (cpuDelta / systemCpuDelta) * cpuCores * 100;
  }

  const memoryUsage = stats.memory_stats.usage || 0;
  const memoryLimit = stats.memory_stats.limit || 1;
  const memoryPercent = (memoryUsage / memoryLimit) * 100;

  const networkRx = stats.networks ? Object.values(stats.networks).reduce((sum, net) => sum + net.rx_bytes, 0) : 0;
  const networkTx = stats.networks ? Object.values(stats.networks).reduce((sum, net) => sum + net.tx_bytes, 0) : 0;

  const diskRead = stats.blkio_stats?.io_service_bytes_recursive?.find(stat => stat.op === 'Read')?.value || 0;
  const diskWrite = stats.blkio_stats?.io_service_bytes_recursive?.find(stat => stat.op === 'Write')?.value || 0;

  let rxDelta = 0;
  let txDelta = 0;
  let readDelta = 0;
  let writeDelta = 0;

  if (lastStats) {
    data.cpuHistory.shift();
    data.cpuHistory.push(cpuPercent);
    data.memoryHistory.shift();
    data.memoryHistory.push(memoryPercent);

    data.networkRxHistory.shift();
    data.networkTxHistory.shift();
    data.diskReadHistory.shift();
    data.diskWriteHistory.shift();

    rxDelta = networkRx - (lastStats.networks ? Object.values(lastStats.networks).reduce((sum, net) => sum + net.rx_bytes, 0) : 0);
    txDelta = networkTx - (lastStats.networks ? Object.values(lastStats.networks).reduce((sum, net) => sum + net.tx_bytes, 0) : 0);

    readDelta = diskRead - (lastStats.blkio_stats?.io_service_bytes_recursive?.find(stat => stat.op === 'Read')?.value || 0);
    writeDelta = diskWrite - (lastStats.blkio_stats?.io_service_bytes_recursive?.find(stat => stat.op === 'Write')?.value || 0);

    data.networkRxHistory.push(rxDelta);
    data.networkTxHistory.push(txDelta);
    data.diskReadHistory.push(readDelta);
    data.diskWriteHistory.push(writeDelta);

    data.labels.shift();
    data.labels.push(formatTime(new Date()));
  } else {
    data.cpuHistory = Array(chartHistory - 1).fill(0).concat([cpuPercent]);
    data.memoryHistory = Array(chartHistory - 1).fill(0).concat([memoryPercent]);
    data.networkRxHistory = Array(chartHistory - 1).fill(0).concat([0]);
    data.networkTxHistory = Array(chartHistory - 1).fill(0).concat([0]);
    data.diskReadHistory = Array(chartHistory - 1).fill(0).concat([0]);
    data.diskWriteHistory = Array(chartHistory - 1).fill(0).concat([0]);
    data.labels = Array(chartHistory - 1).fill('').concat([formatTime(new Date())]);
  }

  data.lastStats = stats;
  data.lastUpdated = Date.now();

  data.formatted = {
    cpu: `${cpuPercent.toFixed(1)}%`,
    memory: `${formatBytes(memoryUsage)} / ${formatBytes(memoryLimit)} (${memoryPercent.toFixed(1)}%)`,
    networkRx: lastStats ? `${formatBytes(rxDelta)}/s` : '0 B/s',
    networkTx: lastStats ? `${formatBytes(txDelta)}/s` : '0 B/s',
    diskRead: lastStats ? `${formatBytes(readDelta)}/s` : '0 B/s',
    diskWrite: lastStats ? `${formatBytes(writeDelta)}/s` : '0 B/s',
    uptime: calculateUptime(containerId)
  };

  updateContainerUI(containerId);
}

function calculateUptime(containerId) {
  if (containerStartTimes[containerId]) {
    const uptime = Date.now() - containerStartTimes[containerId];
    return formatDuration(uptime);
  }

  return 'Calculating...';
}

function updateContainerList(containers) {
  const containersList = document.getElementById('containers-list');

  const loadingMsg = containersList.querySelector('.text-gray-500, .text-red-500');
  if (loadingMsg) {
    loadingMsg.remove();
  }

  const existingContainerElements = {};
  containersList.querySelectorAll('.container-card').forEach(card => {
    existingContainerElements[card.dataset.containerId] = card;
  });

  const processedIds = new Set();

  for (const container of containers) {
    processedIds.add(container.Id);

    const existingCard = existingContainerElements[container.Id];

    if (existingCard) {
      if (existingCard.dataset.state !== container.State) {
        existingCard.dataset.state = container.State;

        const statusElement = existingCard.querySelector('.container-status');
        statusElement.textContent = container.State;
        statusElement.className = 'container-status px-2 py-1 rounded-full text-xs font-medium';

        if (container.State === 'exited') {
          statusElement.classList.add('bg-gray-100', 'text-gray-800');
        } else if (container.State === 'running') {
          statusElement.classList.add('bg-green-100', 'text-green-800');

          if (!containersInitialized.has(container.Id)) {
            setTimeout(() => initializeChart(container.Id), 50);
          }
        } else {
          statusElement.classList.add('bg-yellow-100', 'text-yellow-800');
        }
      }
    } else {
      const containerCard = createContainerCard(container);
      containersList.appendChild(containerCard);

      if (container.State === 'running') {
        setTimeout(() => initializeChart(container.Id), 50);
      }
    }
  }

  Object.keys(existingContainerElements).forEach(containerId => {
    if (!processedIds.has(containerId)) {
      const containerCard = existingContainerElements[containerId];

      if (containerCard.chart) {
        try {
          containerCard.chart.destroy();
        } catch (e) {
          console.error('Error destroying chart:', e);
        }
      }

      containerCard.remove();

      delete containerData[containerId];
      containersInitialized.delete(containerId);
    }
  });

  refreshContainerVisibility();
}

function createContainerCard(container) {
  const template = document.getElementById('container-template');
  const containerCard = document.importNode(template.content, true).firstElementChild;

  containerCard.dataset.containerId = container.Id;
  containerCard.dataset.state = container.State;

  const containerName = container.Names[0].replace(/^\//, '');
  const nameElement = containerCard.querySelector('.container-name');
  nameElement.textContent = containerName;
  nameElement.setAttribute('title', containerName);

  const idElement = containerCard.querySelector('.container-id');
  idElement.textContent = container.Id.substring(0, 12);
  idElement.setAttribute('title', container.Id);

  const statusElement = containerCard.querySelector('.container-status');
  statusElement.textContent = container.State;
  statusElement.className = 'container-status px-2 py-1 rounded-full text-xs font-medium';

  if (container.State === 'exited') {
    statusElement.classList.add('bg-gray-100', 'text-gray-800');
  } else if (container.State === 'running') {
    statusElement.classList.add('bg-green-100', 'text-green-800');

    const data = containerData[container.Id];
    if (data && data.formatted) {
      const cpuUsageEl = containerCard.querySelector('.cpu-usage');
      const memoryUsageEl = containerCard.querySelector('.memory-usage');
      const networkRxEl = containerCard.querySelector('.network-rx');
      const networkTxEl = containerCard.querySelector('.network-tx');
      const diskReadEl = containerCard.querySelector('.disk-read');
      const diskWriteEl = containerCard.querySelector('.disk-write');
      const uptimeEl = containerCard.querySelector('.uptime');

      if (cpuUsageEl && data.formatted.cpu) cpuUsageEl.textContent = data.formatted.cpu;
      if (memoryUsageEl && data.formatted.memory) memoryUsageEl.textContent = data.formatted.memory;
      if (networkRxEl && data.formatted.networkRx) networkRxEl.textContent = data.formatted.networkRx;
      if (networkTxEl && data.formatted.networkTx) networkTxEl.textContent = data.formatted.networkTx;
      if (diskReadEl && data.formatted.diskRead) diskReadEl.textContent = data.formatted.diskRead;
      if (diskWriteEl && data.formatted.diskWrite) diskWriteEl.textContent = data.formatted.diskWrite;
      if (uptimeEl && data.formatted.uptime) uptimeEl.textContent = data.formatted.uptime;
    }
  } else {
    statusElement.classList.add('bg-yellow-100', 'text-yellow-800');
  }

  if (hideExitedContainers && container.State === 'exited') {
    containerCard.classList.add('hidden');
  }

  return containerCard;
}

function initializeChart(containerId) {
  if (containersInitialized.has(containerId)) {
    const containerCard = document.querySelector(`.container-card[data-container-id="${containerId}"]`);
    if (containerCard && containerCard.chart) {
      return;
    }
  }

  const containerCard = document.querySelector(`.container-card[data-container-id="${containerId}"]`);
  if (!containerCard) {
    return;
  }

  const canvas = containerCard.querySelector('.usage-chart');
  if (!canvas) {
    return;
  }

  const ctx = canvas?.getContext('2d');
  if (!ctx) {
    return;
  }

  if (containerCard.chart) {
    try {
      containerCard.chart.destroy();
    } catch (e) {
      console.error('Error destroying chart:', e);
    }
  }

  try {
    // Check if Chart is defined
    if (typeof Chart === 'undefined') {
      console.error('Chart.js library is not loaded or not available');
      return;
    }

    const chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: Array(chartHistory).fill(''),
        datasets: [
          {
            label: 'CPU',
            data: Array(chartHistory).fill(0),
            borderColor: colorPalette[0],
            backgroundColor: colorPalette[0],
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.2,
            yAxisID: 'y'
          },
          {
            label: 'Memory',
            data: Array(chartHistory).fill(0),
            borderColor: colorPalette[1],
            backgroundColor: colorPalette[1],
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.2,
            yAxisID: 'y'
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: {
          mode: 'index',
          intersect: false,
        },
        plugins: {
          legend: {
            display: true,
            position: 'top',
            labels: {
              boxWidth: 12,
              font: {
                size: 10
              }
            }
          },
          tooltip: {
            enabled: true,
            mode: 'index',
            intersect: false,
            displayColors: true,
            callbacks: {
              label: function (context) {
                let label = context.dataset.label || '';
                if (label) {
                  label += ': ';
                }
                if (context.parsed.y !== null) {
                  label += context.parsed.y.toFixed(1) + '%';
                }
                return label;
              }
            }
          }
        },
        scales: {
          x: {
            display: false
          },
          y: {
            type: 'linear',
            display: true,
            position: 'left',
            min: 0,
            max: 100,
            ticks: {
              stepSize: 25,
              font: {
                size: 9
              },
              callback: function (value) {
                return value + '%';
              }
            },
            grid: {
              color: 'rgba(0, 0, 0, 0.05)'
            }
          }
        }
      }
    });

    containerCard.chart = chart;
    containersInitialized.add(containerId);

    const data = containerData[containerId];
    if (data && data.cpuHistory && data.memoryHistory && data.labels) {
      chart.data.labels = data.labels;
      chart.data.datasets[0].data = data.cpuHistory;
      chart.data.datasets[1].data = data.memoryHistory;
      chart.update('none');
    }
  } catch (e) {
    console.error(`Error initializing chart for container ${containerId}:`, e);
  }
}

function updateContainerUI(containerId) {
  const containerCard = document.querySelector(`.container-card[data-container-id="${containerId}"]`);
  if (!containerCard) return;

  const data = containerData[containerId];
  if (!data) return;

  if (!data.formatted) return;

  if (pendingUpdates.has(containerId)) {
    const lastUpdate = pendingUpdates.get(containerId);
    if (Date.now() - lastUpdate < 100) {
      return;
    }
  }

  pendingUpdates.set(containerId, Date.now());

  const cpuUsageEl = containerCard.querySelector('.cpu-usage');
  const memoryUsageEl = containerCard.querySelector('.memory-usage');
  const networkRxEl = containerCard.querySelector('.network-rx');
  const networkTxEl = containerCard.querySelector('.network-tx');
  const diskReadEl = containerCard.querySelector('.disk-read');
  const diskWriteEl = containerCard.querySelector('.disk-write');
  const uptimeEl = containerCard.querySelector('.uptime');

  if (cpuUsageEl && data.formatted.cpu) cpuUsageEl.textContent = data.formatted.cpu;
  if (memoryUsageEl && data.formatted.memory) memoryUsageEl.textContent = data.formatted.memory;
  if (networkRxEl && data.formatted.networkRx) networkRxEl.textContent = data.formatted.networkRx;
  if (networkTxEl && data.formatted.networkTx) networkTxEl.textContent = data.formatted.networkTx;
  if (diskReadEl && data.formatted.diskRead) diskReadEl.textContent = data.formatted.diskRead;
  if (diskWriteEl && data.formatted.diskWrite) diskWriteEl.textContent = data.formatted.diskWrite;
  if (uptimeEl && data.formatted.uptime) uptimeEl.textContent = data.formatted.uptime;

  if (!containersInitialized.has(containerId)) {
    initializeChart(containerId);
    return;
  }

  const chart = containerCard.chart;
  if (chart && data.cpuHistory && data.memoryHistory && data.labels) {
    if (data.cpuHistory.length !== chartHistory ||
      data.memoryHistory.length !== chartHistory ||
      data.labels.length !== chartHistory) {
      pendingUpdates.delete(containerId);
      return;
    }

    if (data.cpuHistory.some(val => val > 0) || data.memoryHistory.some(val => val > 0)) {
      chart.data.labels = data.labels;
      chart.data.datasets[0].data = data.cpuHistory;
      chart.data.datasets[1].data = data.memoryHistory;

      chart.update('none');
    }

    pendingUpdates.delete(containerId);
  } else {
    pendingUpdates.delete(containerId);
  }
}

function formatBytes(bytes, decimals = 1) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  return `${hours}h ${minutes}m ${remainingSeconds}s`;
}

function formatTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function calculateRatePerSecond(history) {
  if (history.length < 2) return 0;

  const newest = history[history.length - 1];
  const oldest = history[history.length - 2];

  if (oldest === undefined || newest < oldest) {
    return newest;
  }

  return newest - oldest;
}
