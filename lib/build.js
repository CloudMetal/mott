"use strict";

var when = require('when'),
    browserify = require('browserify'),
    templatify = require('templatify'),
    common = require('./common'),
    sequence = require('sequence'),
    uglify = require('uglify-js'),
    nconf = require('nconf'),
    path = require('path'),
    less = require('less'),
    hbs = require('hbs');

module.exports = function build(grunt){
    grunt.registerTask('build', 'Compile all JS and LESS.', function(){
        var done = this.async();
        grunt.helper('build').then(function(){
            done();
        });
    });

    nconf.get('PLATFORMS').forEach(function(platform){
        grunt.registerTask('build.' + platform, 'Compile all JS and LESS for '+platform+'.', function(){
            var done = this.async();
            grunt.helper('build', platform).then(function(){
                done();
            });
        });
    });

    // Compile all JS and LESS.
    grunt.registerHelper('build', function(platform){
        var start = new Date(),
            platforms = (platform) ? [platform] : nconf.get('PLATFORMS');

        return when.all(platforms.map(function(platform){
            return grunt.helper('generateConfig', platform);
        })).then(function(){
            common.log('Compiling Strings...');
            return grunt.helper('compileStrings');
        }).then(function(){
            common.log('Building LESS and JS');
            return when.all([
                grunt.helper('buildLess'),
                grunt.helper('buildJS'),
            ]);
        }).then(function(){
            common.logStat('build', start, 2000);
        });
    });

    // Use browserify and templatify to compile all of the JS.
    grunt.registerHelper('buildJS', function(){
        var bundles,
            templateBundles = {},
            assets = nconf.get('ASSETS'),
            start = new Date();

        nconf.get('PLATFORMS').forEach(function(platform){
            templateBundles[platform] = browserify().use(templatify('./', {
                    'files': [
                        assets + '/common/templates/*.html',
                        assets + '/common/templates/partials/*.html',
                        assets + '/'+platform+'/templates/*.html',
                        assets + '/web/templates/partials/*.html'
                    ],
                    'helpers': [
                        assets + '/'+platform+'/js/helpers/*.js',
                        assets + '/common/js/helpers/*.js'
                    ]
                })
            );
        });

        return when.all(Object.keys(templateBundles).map(function(platform){
            var ignores = [],
                bundle,
                templatesJS = templateBundles[platform].bundle();

            return common.writeFile(assets + '/' + platform + '/templates.js', templatesJS).then(function(){
                // Write our templates file and then we can generate our main
                // browserify bundle.
                // @todo (lucas) Would be nice if we didnt have to do this in two steps...
                Object.keys(templateBundles[platform].templatify).forEach(function(f){
                    ignores.push(f);
                });

                bundle = browserify(assets + '/'+ platform +'/js/main.js', {
                    'require': [
                        assets + '/common/js/strings.js',
                        'util'
                    ],
                    'ignore': ignores,
                    'debug': (nconf.get('NODE_ENV') === 'development'),
                    'exports': ['process']
                });

                bundle.on('syntaxError', function(e){
                    console.error('Bundle syntax error: ', e);
                });

                bundle.prepends.splice(0, 1);

            }).then(function(){
                // Now that out bundle is ready, let's add our vendor files
                // to it so we dont have to require them all over the place.
                // @todo (lucas) Would be great if we could remove this step as well.
                // jquery-browserify and browserify-backbone do this successfully
                // for stormwatch.
                var files = [
                    'zepto.js',
                    'polyfills.js',
                    'backbone.js'];

                files.reverse();
                return require('when/sequence')(files.map(function(file){
                    return function(){
                        return common.readFile(assets + '/../vendor/' + file, 'utf-8').then(function(data){
                            bundle.prepend(data);
                        });
                    };
                }));
            }).then(function(){
                // Generate the bundle source string
                // and run optionally run it through uglify for minification.
                bundle.prepend(templatesJS);
                var src = bundle.bundle();
                if(nconf.get('MINIFY')){
                    src = uglify(src);
                }
                return common.writeFile(assets + '/'+ platform +'/app.js', src);
            }).then(function(next){
                // Build our bootstrap.js file (see below).
                return grunt.helper('buildBootstrap', platform);
            }).then(function(next){
                // All done!
                return platform;
            });
        })).then(function(){
            common.logStat('build js', start, 1000);
        });
    });

    // Compiles less files for all platforms.
    grunt.registerHelper('buildLess', function(){
        var options = {
                'compress': nconf.get('MINIFY'),
                'yuicompress': false,
                'optimization': 1,
                'strictImports': false
            },
            assets = nconf.get('ASSETS'),
            start = new Date();

        return when.all(nconf.get('PLATFORMS').map(function(platform){
            var entrypoint = assets + '/' + platform + '/less/main.less';
            return common.readFile(entrypoint, 'utf-8').then(function(data){
                var p = when.defer();
                new less.Parser({
                    paths: [path.dirname(entrypoint)],
                    optimization: options.optimization,
                    filename: entrypoint,
                    strictImports: options.strictImports
                }).parse(data, function (err, tree) {
                    if (err){
                        throw new Error(err);
                    }
                    p.resolve({
                        'path': entrypoint,
                        'data': data,
                        'css': tree.toCSS({
                            compress: options.compress,
                            yuicompress: options.yuicompress
                        })
                    });
                });
                return p.promise;
            }).then(function(result){
                var buffer = result.css,
                    regex = /url\(\/"?([\w\d\/\-\.\?\#\@]+)"?\)/g,
                    replacement = (platform === 'web') ? "url(/$1)" :  "url($1)";

                    buffer = buffer.replace(regex, replacement);

                return common.writeFile(assets + '/' + platform + '/app.css', buffer,'utf-8');
            });
        })).then(function(){
            common.logStat('build less', start, 200);
        });
    });


    grunt.registerHelper('buildBootstrap', function(platform){
        var template,
            tplsVars,
            assets = nconf.get('ASSETS'),
            socketioUrl = nconf.get('BASE_URL').replace(/\:\d+/, '') + ':7002/',
            version = nconf.get('VERSION'),
            versionCode = nconf.get('VERSION_CODE'),
            paths = [
                assets + '/' + platform + '/app.js',
                assets + '/' + platform + '/app.css'
            ];

        function writeBootstrap(){
            return common.readFile(assets + '/' + platform + '/bootstrap.tpl', 'utf-8').then(function(data){
                return hbs.handlebars.compile(data);
            }).then(function(template){
                return template(tplsVars);
            }).then(function(bootstrap){
                return common.writeFile(assets + '/' + platform + '/bootstrap.js', bootstrap);
            });
        }

        if(nconf.get('NODE_ENV') === 'development'){
            if(!nconf.get('SOCKETIO')){
                socketioUrl = null;
            }

            tplsVars = {
                'JSURL': nconf.get('BASE_URL') + '/' + platform + '/app.js',
                'JSVersion': '',
                'CSSURL': nconf.get('BASE_URL') + '/' + platform + '/app.css',
                'CSSVersion': '',
                'version': version,
                'versionCode': versionCode,
                'env': 'development',
                'socketio': socketioUrl,
                'weinre': nconf.get('WEINRE')
            };

            return when.all(paths.map(function(p){
                return grunt.helper('fileInfo', p).then(function(info){
                    if(p.indexOf('.css') > -1){
                        return tplsVars.CSSVersion = info.sha;
                    }
                    return tplsVars.JSVersion = info.sha;
                });
            })).then(function(){
                return writeBootstrap();
            });
        }

        tplsVars = {
            'JSURL': nconf.get('BASE_URL') + '/' + platform + '/app.js',
            'JSVersion': '',
            'CSSURL': nconf.get('BASE_URL') + '/' + platform + '/app.css',
            'CSSVersion': '',
            'version': version,
            'versionCode': versionCode,
            'env': nconf.get('NODE_ENV')
        };

        return when.all(paths.map(function(p){
            return grunt.helper('fileInfo', p).then(function(info){
                if(p.indexOf('.css') > -1){
                    tplsVars.CSSURL = info.url;
                    tplsVars.CSSVersion = info.sha;
                }
                else{
                    tplsVars.JSURL = info.url;
                    tplsVars.JSVersion = info.sha;
                }
            });
        })).then(function(){
            return writeBootstrap();
        });
    });
};