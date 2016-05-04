var config = require('./config.json');
var spawnargs = require('spawn-args');
var extend = require('xtend');
var qv2 = require('qv2');
var q = qv2();
var irc = require('irc');
var PastebinAPI = require('pastebin-js');
var pastebin = new PastebinAPI({
    'api_dev_key' : config.pastebinKey
});
var async = require('async');
var request = require('request');
var fs = require('fs');
var jsdom = require('jsdom');
var regex = /@?Hakata[,:]? \.(.+)/;
var allowedIrc = []; // just for admin stuff
var processing = false;
var client = new irc.Client(config.server, config.name, {
    port: config.port,
    userName: config.name,
    realName: 'Hakata',
    secure: config.ssl,
    selfSigned: config.dealWithSSL,
    certExpired: config.dealWithSSL,
    autoRejoin: true,
    autoConnect: true,
    retryCount: 3
});
var queues = {};

function generateQueue(name, fn) {
    queues[name] = qv2();
    queues[name].processing = false;
    setInterval(function() {
        if (queues[name].processing == false) {
            var dq = queues[name].dequeue();
            if (dq != undefined) {
                dq.msg = function(msg) {
                    client.say(config.channel, dq.name + ': ' + msg);
                };
                queues[name].processing = true;
                fn.call(queues[name], dq);
            }
        }
    }, 100);
}

function tell(msg) {
    client.say(config.channel, msg);
}

function alert(msg) {
    client.say('r3c0d3x', msg);
}

generateQueue('links', function(opts) {
    var done = { bing: false };
    var reqOpts = {
        method: 'get',
        headers: {
            'user-agent': ' Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/49.0.2623.112 Safari/537.36',
            'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'accept-encoding': 'gzip',
            'accept-language': 'en-US,en;q=0.8'
        },
        gzip: true
    };
    var urls = [];

    if (typeof opts.args['-url'] == 'undefined') {
        opts.msg('Missing a parameter!');
        return;
    }

    function parse(selector, engine, wcb) {
        return function(reqErr, res, body) {
            if (reqErr)
                alert(reqErr);
            else
                jsdom.env(body, function(domErr, window) {
                    if (domErr)
                        alert(domErr);
                    else {
                        var document = window.document;
                        var count = 0;
                        Array.prototype.slice.call(document.querySelectorAll(selector)).forEach(function(curr) {
                            count++;
                            //console.log(curr.href);
                            urls.push(curr.href);
                        });
                        if (engine == 'bing') {
                            if (document.querySelectorAll('ol#b_results > li.b_pag > nav > ul > li:last-of-type > a.sb_pagN').length == 0) {
                                done[engine] = true;
                                window.close();
                                wcb(null);
                                return;
                            }
                        }
                        window.close();
                        if (count == 0)
                            done[engine] = true;
                        wcb(null);
                    }
                });
        };
    }

    async.parallel([function(pCb) {
        var page = 0;
        var perpage = 50;

        async.whilst(function() {
            return !done.bing;
        }, function(wcb) {
            setTimeout(function() {
                request(extend(reqOpts, { uri: 'https://www.bing.com/search?q=site%3a' + opts.args['-url'] + '&count=50&first=' + (page * perpage + 1) }), parse('li.b_algo h2 a', 'bing', wcb));
                page++;
            }, 3000);
        }, function(err) {
            pCb(null, urls);
        });
    }, ], function(err, res) {
        pastebin
            .createPaste(urls.join('\n'), opts.name + ' - ' + opts.args['-url'], null, 1, '10M')
            .then(function(url) {
                opts.msg('http://pastebin.com/raw/' + url);
                this.processing = false;
            });
    });
});

generateQueue('ping', function(opts) {
    opts.msg('Pong!');
    this.processing = false;
});

generateQueue('echo', function(opts) {
    opts.msg(opts.literal);
    this.processing = false;
});

generateQueue('cmds', function(opts) {
    var msgs = [];
    var cmds = Object.getOwnPropertyNames(queues);
    for (var i = 0; i < cmds.length; i++) {
        var skip = 0;
        var line = cmds[i];
        if (typeof cmds[i+1] != 'undefined') {
            skip++;
            line += ' ' + cmds[i + 1];
        }
        if (typeof cmds[i+2] != 'undefined') {
            skip++;
            line += ' ' + cmds[i + 2];
        }
        i+=skip;
        msgs.push(line);
    }
    msgs.forEach(function (curr) {
        opts.msg(curr);
    });
    this.processing = false;
});

client.addListener('motd', function(motd) {
    console.log(motd + '\n');
    if (config.nickserv) {
        client.say('NickServ', 'IDENTIFY ' + config.pass);
        setTimeout(function() {
            client.join(config.channel);
        }, 1000);
    }
});

client.addListener('names', function(channel, nicks) {
    if (channel == config.channel)
        Object.getOwnPropertyNames(nicks).forEach(function(curr) {
            if (nicks[curr] != '')
                allowedIrc.push(curr);
        });
});

client.addListener('message' + config.channel, function(nick, text, message) {
    var name = '';
    var prefix = '';
    var baseCmd = '';
    var cmd = '';
    var literal = '';
    var allowed = false;

    if (nick == 'dscb') {
        prefix = '@';
        var res = /<([\w\d\s]+)> ?@?Hakata[,:]? \.(.+)/.exec(text);
        if (res != null) {
            name = res[1];
            cmd = res[2];
            config.dscb.forEach(function(curr) {
                if (curr == name)
                    allowed = true;
            });
        } else return;
    } else {
        allowedIrc.forEach(function(curr) {
            if (curr == nick)
                allowed = true;
        });
        var res = regex.exec(text);
        if (res != null) {
            name = nick;
            cmd = res[1];
        } else return;
    }

    if (!allowed)
        return;

    var args = spawnargs(cmd);
    baseCmd = args.shift();
    literal = args.join(' ');
    var parsed = {};
    for (var i = 0; i < args.length; i++) {
        parsed[args[i]] = args[i+1]; i++; 
    }

    if (typeof queues[baseCmd] !== 'undefined')
        queues[baseCmd].enqueue({ cmd: baseCmd, args: parsed, name: prefix + name, allowed: allowed, literal: literal });
    else
        tell(prefix + name + ': ' + 'Unknown command!');
});
