/**
 * Run from `npm run generate-api-docs`
 */
// @ts-check

const {Analyzer, FsUrlLoader, PackageUrlResolver, generateAnalysis} =
    require('polymer-analyzer');
const format = require('polymer-analyzer/lib/analysis-format/analysis-format');

const fs = require('fs');
const childProcess = require('child_process');
const escape = require('html-escape');
const path = require('path');
const globby = require('globby');

async function exec(command) {
  process.stdout.write(`Running \`${command}\` ...`);
  const result = await new Promise((resolve, reject) => {
    childProcess.exec(command, (err, stdout, stderr) => {
      err ? reject(err) : resolve([stdout, stderr]);
    });
  });
  console.log(` done.`);
  return result;
}

const apiDocsPath = '../app/3.0/docs/api/';
const rootNamespace = 'Polymer';

// TODO: Check out an actual release SHA to generate docs off of.
const releaseCommitish = '3.x';

process.on('unhandledRejection', (reason, p) => {
  console.log('Unhandled Rejection at: Promise ', p, ' reason: ', reason);
});

async function main() {
  let rootDir;
  if (process.argv[2]) {
    rootDir = path.resolve(process.argv[2]);
  } else {
    await exec('rm -rf ./temp');
    await exec('git clone https://github.com/Polymer/polymer.git temp');
    await exec(`cd temp && git checkout ${releaseCommitish} && cd ..`);
    rootDir = path.resolve('temp');
  }
  await exec(`rm -rf ${apiDocsPath}*`);

  const isInTests = /(\b|\/|\\)(test)(\/|\\)/;
  const isNotTest = (f) =>!f.sourceRange || (!isInTests.test(f.sourceRange.file) && !f.sourceRange.file.endsWith('gulpfile.js'));

  const analyzer = new Analyzer({
    urlLoader : new FsUrlLoader(rootDir),
    urlResolver : new PackageUrlResolver({packageDir : rootDir}),
  });

  process.stdout.write('Analyzing...');
  const globs = ['*.js', 'lib/**/*'].map(f => path.join(rootDir, f));
  const inputs = (await globby(globs)).filter(f => !f.endsWith('gulpfile.js')).map(f => path.relative(rootDir, f));
  const resolvedAnalysis = await analyzer.analyze(inputs);
  const analysis = generateAnalysis(
      resolvedAnalysis, analyzer.urlResolver, isNotTest);
  const json = JSON.stringify(analysis, null, 2);
  fs.writeFileSync('polymer3_analysis.json', json);
  console.log(' done.');

  function generateNamespace(namespace) {

    const overview = {
      name : namespace.name,
      description : namespace.description,
      summary : namespace.summary,
      namespaces : [],
      elements : [],
      classes : [],
      mixins : [],
      behaviors : [],
      functions : namespace.functions, // already summarized
    };

    if (namespace.elements) {
      for (const element of namespace.elements) {
        const summary = {
          name : element.name,
          tagname : element.tagname,
          summary : element.summary,
        };
        overview.elements.push(summary);
        const fileContents = elementPage(element);
        const filename =
            path.join(apiDocsPath, getElementUrl(element) + '.html');
        fs.writeFileSync(filename, fileContents);
      }
    }

    if (namespace.classes) {
      for (const klass of namespace.classes) {
        if (!klass.name) {
          continue;
        }
        const summary = {
          name : klass.name,
          summary : klass.summary,
        };
        overview.classes.push(summary);
        const fileContents = classPage(klass);
        const filename = path.join(apiDocsPath, getClassUrl(klass) + '.html');
        fs.writeFileSync(filename, fileContents);
      }
    }

    if (namespace.mixins) {
      for (const mixin of namespace.mixins) {
        const summary = {
          name : mixin.name,
          summary : mixin.summary,
        };
        overview.mixins.push(summary);

        const fileContents = mixinPage(mixin);
        const filename = path.join(apiDocsPath, getMixinUrl(mixin) + '.html');
        fs.writeFileSync(filename, fileContents);
      }
    }

    if (namespace.namespaces) {
      for (const nestedNamespace of namespace.namespaces) {
        const summary = {
          name : nestedNamespace.name,
          summary : nestedNamespace.summary,
        };
        overview.namespaces.push(summary);
        generateNamespace(nestedNamespace);
      }
    }

    if (namespace.name) {
      const fileContents = namespacePage(overview);
      let filename;
      if (namespace.name === 'Polymer') {
        filename = 'index.html';
      } else {
        filename = getNamespaceUrl(namespace) + '.html';
      }
      const filepath = path.join(apiDocsPath, filename);
      fs.writeFileSync(filepath, fileContents);
    }
  }
  fs.mkdirSync(path.join(apiDocsPath, 'elements'));
  fs.mkdirSync(path.join(apiDocsPath, 'legacy'));
  fs.mkdirSync(path.join(apiDocsPath, 'mixins'));
  fs.mkdirSync(path.join(apiDocsPath, 'utils'));
  const index = indexFeaturesByFile(analysis);
  fs.writeFileSync(
      path.join(apiDocsPath, 'index.html'),
      getIndexPage(analysis, index),
      'utf-8');

  for (const [filename, result] of index) {
    const fileContents = modulePage(filename, result.analysis);
    const htmlFilename = path.join(apiDocsPath, filename.split('/').filter(f => f !== 'lib').join('/').replace(/\.js$/, '.html'));
    fs.writeFileSync(htmlFilename, fileContents);
  }
}

/** @typedef {format.Element|format.Class|format.Function|format.ElementMixin} SimpleFeature */
/** @typedef {Map<string, {allFeatures: SimpleFeature[], analysis: format.Analysis}>} FeatureIndex */

/** @param {format.Analysis} analysis */
function indexFeaturesByFile(analysis) {
  /** @type {FeatureIndex} */
  const map = new Map();
  /** @param {SimpleFeature} feature */
  function index(feature, kind) {
    const filename = getFilename(feature) || '???';
    let result = map.get(filename);
    if (result === undefined) {
      result = {
        allFeatures: [],
        analysis: {
          schema_version: '1.0'
        }
      };
      map.set(filename, result);
    }
    result.allFeatures.push(feature);
    result.analysis[kind] = result.analysis[kind] || [];
    result.analysis[kind].push(feature);
  }
  (analysis.elements || []).map(f => index(f, 'elements'));
  (analysis.classes || []).map(f => index(f, 'classes'));
  (analysis.functions || []).map(f => index(f, 'functions'));
  (analysis.mixins || []).map(f => index(f, 'mixins'));
  return map;
}

/**
 * @param {format.Analysis} analysis
 * @param {FeatureIndex} index
 */
function getIndexPage(analysis, index) {
  // We filter out the toplevel files because we want to document them first,
  // and with a bit more detail because they're the main entrypoints.
  const filenames = [...index.keys()].sort().filter(fn => fn.startsWith('lib'));
  const withoutLib = filenames.map(fn => {
    if (fn.startsWith('lib/')) {
      return fn.slice(4);
    }
    throw new Error(`${fn} was expected to be in lib/`);
  });
  /** @type {Map<string, string[]>} */
  const filenamesBySubdir = new Map();
  for (const filename of filenames) {
    const subdir = getSubdir(filename);
    const inSubdir = filenamesBySubdir.get(subdir) || [];
    inSubdir.push(filename);
    filenamesBySubdir.set(subdir, inSubdir);
  }

  return `{% set markdown = "true" %}
{% set title = "Polymer API Docs" %}
{% extends "templates/base-devguide.html" %}
{% block title %} Polymer API Reference {% endblock %}
{% block content %}

<style>
  .apidocs-main {
    padding: 20px 40px;
  }
  .apidocs-main section {
    padding: 15px 40px;
  }
</style>
<div class="apidocs-main">
<section>
  <div class="name">PolymerElement</div>
  <div class='description'>
    Base class that provides the core API for Polymer's meta-programming
    features including template stamping, data-binding, attribute
    deserialization, and property change observation.
  </div>
</section>

${[...new Set(['elements', 'mixins', 'utils', 'legacy', ...filenamesBySubdir.keys()])].map((section) => getIndexPageSubsection(section, filenamesBySubdir.get(section), index)).join('\n\n')}

</div>
{% endblock %}
`
}

/** @param {string} fn */
function getSubdir(fn) {
  return fn.split('/')[1];
}

/**
 *
 * @param {string} subsection
 * @param {Array<string>} filenamesIn
 * @param {FeatureIndex} featureIndex
 */
function getIndexPageSubsection(subsection, filenamesIn, featureIndex) {
  if (filenamesIn === undefined) {
    console.log(`subsection: ${subsection}`);
  }
  return `

<section anchor-id="${subsection}">
  <h2>${subsection}</h2>

  ${filenamesIn.map(fn => getFilenameDescription(fn, featureIndex)).join('\n\n')}
</section>
`
}

const hardcodedDescriptions = new Map([
  ['lib/elements/array-selector.js', `
      Module providing tools for maintaining a mapping between a master
      \`items\` array and a subset of those items that are selected.
  `],

  ['lib/legacy/class.js', `
      Utilities for constructing a Polymer 1.x-compatible class, including
      mixing in behaviors.
  `],
  ['lib/legacy/legacy-element-mixin.js', `
      Element class mixin that provides Polymer's "legacy" API.
  `],
  ['lib/legacy/mutable-data-behavior.js', `
      Behaviors for skipping strict dirty checking of objects and arrays.
  `],
  ['lib/legacy/polymer-fn.js', `
      Legacy class factory and registration helper for defining Polymer
      elements.
  `],
  ['lib/legacy/polymer.dom.js', `
      Legacy DOM and Event manipulation API wrapper factory used to abstract
      differences between native Shadow DOM and "Shady DOM" when polyfilling on
      older browsers. No longer necessary, but still provided for backwards
      compatibility.
  `],
  ['lib/legacy/templatizer-behavior.js',  `
      Used for creating data-binding templates. Exposed as a behavior for
      hybrid-element convenience. For non-hybrid usage, the \`Templatize\`
      library in \`utils\` should be used instead.
  `],

  ['lib/mixins/dir-mixin.js', `
      Mixin that allows elements to use the \`:dir\` CSS Selector to
      have text direction specific styling.
  `],
  ['lib/mixins/disable-upgrade-mixin.js', `
      Mixin that allows the element to boot up in a non-enabled
      state when the \`disable-upgrade\` attribute is present. This mixin is
      designed to be used with element classes like PolymerElement that perform
      initial startup work when they are first connected.
  `],
  ['lib/mixins/element-mixin.js',  `
      Element class mixin that provides the core API for Polymer's
      meta-programming features. Also provides some telemetry APIs.
  `],
  ['lib/mixins/mutable-data.js', `
      Mixins for skipping strict dirty checking of objects and arrays.
  `],

  ['lib/mixins/element-mixin.js',  `
      Element class mixin that provides the core API for Polymer's
      meta-programming features. Also provides some telemetry APIs.
  `],

  ['lib/utils/array-splice.js', `
      Computes an array of splice records indicating the minimum edits required
      to transform the \`previous\` array into the \`current\` array.
  `],
  ['lib/utils/case-map.js', `
      Module that provides utilities for converting between "dash-case"
      and "camelCase".
  `],
  ['lib/utils/debounce.js', `
      Collapse multiple callbacks into one invocation after a timer.
  `],
  ['lib/utils/flattened-nodes-observer.js', `
      Class that listens for changes (additions or removals) to "flattened
      nodes" on a given \`node\`.`
  ],
  ['lib/utils/flush.js', `
      Forces several classes of asynchronously queued tasks to synchronously
      execute.
  `],
  ['lib/utils/gestures.js', `
      Module for adding cross-platform gesture event listeners.
  `],
  ['lib/utils/html-tag.js', `
      A template literal tag that creates an HTML \`<template>\` element from
      the contents of the string. This allows you to write a Polymer Template
      in JavaScript.
  `],
  ['lib/utils/import-href.js', `
      Module providing a convenience method for importing an HTML document
      imperatively.
  `],
  ['lib/utils/mixin.js', `
      Module providing utility functions for ES6 class expression mixins.
  `],
  ['lib/utils/path.js', `
      Module with utilities for manipulating structured data path strings.
  `],
  ['lib/utils/render-status.js', `
      Module for scheduling flushable pre-render and post-render tasks.
  `],
  ['lib/utils/resolve-url.js', `
      Module with utilities for resolving URLs against a provided \`baseUri\'.
  `],
  ['lib/utils/settings.js', `
      Module to read and write a small number of global configuration
      properties.
  `],
  ['lib/utils/style-gather.js', `
      Module with utilities for collection CSS text from various sources.
  `],
  ['lib/utils/templatize.js', `
      Module for preparing and stamping templates that
      utilize Polymer templating features.
  `],

]);


/**
 * @param {string} filename
 * @param {FeatureIndex} featureIndex
 */
function getFilenameDescription(filename, featureIndex) {
  const result = featureIndex.get(filename);
  if (result === undefined) {
    throw new Error(`Got no features for filename ${filename}`);
  }
  const features = result.allFeatures;
  const shortName = filename.split('/').slice(2).join('/');
  let description;
  if (features.length === 1) {
    const [feature] = features;
    description = feature.summary;
  }
  description = description || hardcodedDescriptions.get(filename) || `TODO(write me): ${filename}`;

  return `
    <section>
      <div class="name">${shortName}</div>
      <div class='description'>
        ${description}
      </div>
    </section>
  `
}

/**
 * @param {string} filename
 * @param {format.Analysis} moduleAnalysis
 */
function modulePage(filename, moduleAnalysis) {
  const jsonString = escape(JSON.stringify(moduleAnalysis));
  return `{% set markdown = "true" %}
{% set title = "${filename}" %}
{% extends "templates/base-devguide.html" %}
{% block title %} API Reference for ${filename}{% endblock %}
{% block content %}
<iron-doc-viewer base-href="/3.0/docs/api" descriptor="${
      jsonString}"></iron-doc-viewer>
{% endblock %}
`
}

/** @param {format.Element} element */
function elementPage(element) {
  const name = getElementName(element);
  const jsonString = escape(JSON.stringify(element));
  return `{% set markdown = "true" %}
{% set title = "${name}" %}
{% extends "templates/base-devguide.html" %}
{% block title %} API Reference - ${name}{% endblock %}
{% block content %}
<iron-doc-element base-href="/3.0/docs/api" descriptor="${
      jsonString}"></iron-doc-element>
{% endblock %}`;
}

/** @param {format.Class} klass */
function classPage(klass) {
  const name = klass.name;
  const jsonString = escape(JSON.stringify(klass));
  return `{% set markdown = "true" %}
{% set title = "${name}" %}
{% extends "templates/base-devguide.html" %}
{% block title %} API Reference - ${name}{% endblock %}
{% block content %}
<iron-doc-class base-href="/3.0/docs/api" descriptor="${
      jsonString}"></iron-doc-class>
{% endblock %}`;
}

/** @param {format.ElementMixin} mixin */
function mixinPage(mixin) {
  const name = mixin.name;
  const jsonString = escape(JSON.stringify(mixin));
  return `{% set markdown = "true" %}
{% set title = "${name}" %}
{% extends "templates/base-devguide.html" %}
{% block title %} API Reference - ${name}{% endblock %}
{% block content %}
<iron-doc-mixin base-href="/3.0/docs/api" descriptor="${
      jsonString}"></iron-doc-mixin>
{% endblock %}`;
}

/** @param {format.Namespace} namespace */
function namespacePage(namespace) {
  const name = namespace.name;
  const jsonString = escape(JSON.stringify(namespace));
  return `{% set markdown = "true" %}
{% set title = "${name}" %}
{% extends "templates/base-devguide.html" %}
{% block title %} API Reference - ${name}{% endblock %}
{% block content %}
<iron-doc-namespace base-href="/3.0/docs/api" descriptor="${
      jsonString}"></iron-doc-namespace>
{% endblock %}`;
}


/** @param {format.Element} element */
function getElementName(element) {
  let name = '';
  if (element.tagname) {
    name += `<${element.tagname}>`;
    if (element.name) {
      name += ` (${element.name})`;
    }
  } else if (element.name) {
    name += element.name;
  }
  return name;
}

/** @param {format.Element} element */
function getElementUrl(element) {
  return `/elements/${element.name || element.tagname}`;
}

/** @param {format.Class} klass */
function getClassUrl(klass) { return `/classes/${klass.name}`; }

/** @param {format.ElementMixin} mixin */
function getMixinUrl(mixin) { return `/mixins/${mixin.name}`; }

/** @param {format.Namespace} namespace */
function getNamespaceUrl(namespace) { return `/namespaces/${namespace.name}`; }

/** @param {SimpleFeature} feature */
function getFilename(feature) {
  if (feature.sourceRange && feature.sourceRange.file) {
    return feature.sourceRange.file;
  }
  if ('path' in feature && feature.path) {
    return feature.path;
  }
  return undefined;
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e ? e.stack || e.message || e: `Unknown error`);
    process.exitCode = 1;
  });
}
