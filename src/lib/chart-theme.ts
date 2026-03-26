// ApexCharts theme for niejedzie.pl
// Matches: Outfit font, burnt sienna palette, cream background, JetBrains Mono for data

export const niedzieje = {
  chart: {
    fontFamily: 'Outfit, system-ui, sans-serif',
    background: 'transparent',
    toolbar: { show: false },
    zoom: { enabled: false },
    animations: {
      enabled: true,
      easing: 'easeinout',
      speed: 600,
      animateGradually: { enabled: true, delay: 80 },
      dynamicAnimation: { enabled: true, speed: 300 },
    },
  },
  colors: ['#c2410c', '#e67e22', '#16a34a', '#d97706', '#dc2626', '#78716c'],
  fill: {
    type: 'gradient',
    gradient: {
      shadeIntensity: 1,
      opacityFrom: 0.4,
      opacityTo: 0.05,
      stops: [0, 90, 100],
    },
  },
  stroke: {
    curve: 'smooth' as const,
    width: 2.5,
    lineCap: 'round' as const,
  },
  grid: {
    borderColor: '#e7e5e0',
    strokeDashArray: 4,
    padding: { left: 8, right: 8 },
    xaxis: { lines: { show: false } },
    yaxis: { lines: { show: true } },
  },
  xaxis: {
    labels: {
      style: {
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: '10px',
        colors: '#a8a29e',
      },
    },
    axisBorder: { show: true, color: '#e7e5e0' },
    axisTicks: { show: false },
    crosshairs: {
      stroke: { color: '#c2410c', width: 1, dashArray: 4 },
    },
  },
  yaxis: {
    labels: {
      style: {
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: '10px',
        colors: '#a8a29e',
      },
    },
  },
  tooltip: {
    theme: 'light',
    style: {
      fontFamily: 'JetBrains Mono, monospace',
      fontSize: '11px',
    },
    x: { show: true },
    marker: { show: true },
  },
  dataLabels: {
    enabled: false,
    style: { fontFamily: 'JetBrains Mono, monospace', fontSize: '10px' },
  },
  legend: {
    fontFamily: 'Outfit, system-ui, sans-serif',
    fontSize: '12px',
    labels: { colors: '#78716c' },
    markers: { size: 4, shape: 'circle' as const },
    itemMargin: { horizontal: 12 },
  },
  states: {
    hover: { filter: { type: 'darken', value: 0.05 } },
    active: { filter: { type: 'darken', value: 0.1 } },
  },
};

// Sparkline variant — minimal, no axes, no grid
export const sparklineTheme = {
  ...niedzieje,
  chart: {
    ...niedzieje.chart,
    sparkline: { enabled: true },
    animations: { ...niedzieje.chart.animations, speed: 400 },
  },
  stroke: { curve: 'smooth' as const, width: 2 },
  tooltip: { ...niedzieje.tooltip, fixed: { enabled: false } },
};

// Radial gauge variant
export const gaugeTheme = {
  ...niedzieje,
  plotOptions: {
    radialBar: {
      startAngle: -135,
      endAngle: 135,
      hollow: { size: '65%', background: 'transparent' },
      track: {
        background: '#e7e5e0',
        strokeWidth: '100%',
        margin: 0,
      },
      dataLabels: {
        name: {
          show: true,
          fontSize: '11px',
          fontFamily: 'JetBrains Mono, monospace',
          color: '#a8a29e',
          offsetY: 20,
        },
        value: {
          show: true,
          fontSize: '28px',
          fontFamily: 'Outfit, system-ui, sans-serif',
          fontWeight: '800',
          color: '#1c1917',
          offsetY: -16,
          formatter: (val: number) => val.toFixed(1) + '%',
        },
      },
    },
  },
};
