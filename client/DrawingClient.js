(function() {
  var requestAnimationFrame = window.requestAnimationFrame || window.mozRequestAnimationFrame ||
                              window.webkitRequestAnimationFrame || window.msRequestAnimationFrame;
  window.requestAnimationFrame = requestAnimationFrame;
})();
function DrawingClient (options) {

    var TOOLS = {
        BRUSH: 1,
        ERASER: 2
    }

    function DrawQueue () {
        var fifo = [],
        executing = false;
        //Dat pun
        var exequeute = function () {
            if (!executing) { // simple lock
                executing = true;
            } else { // don't try to process same queue twice
                return;
            }

            while (fifo.length > 0) {
                var task = fifo.shift();

                task();
            }
            executing = false;
        };

        return {
            add: function (dfrdFnc) {
                fifo.push(dfrdFnc);
                exequeute();
            },
            run: function (dfrdFnc) {
                exequeute();
            }
        }
    }

    function TimeCapsule() {
        var time = 0;
        this.getLapse = function() {
            if (time === 0) time = (new Date()).getTime();
            var newTime = (new Date()).getTime();
            var delay = newTime - time;
            time = newTime;
            return delay;
        };
        return this;
    }

    // this is really the JSHTML code client:
    var DrawingClientView = Backbone.View.extend({
        className: "drawingClient",

        template: _.template($("#drawingTemplate").html()),

        initialize: function (opts) {
            var self = this;

            _.bindAll(this);

            this.socket = io.connect("/draw");
            this.channelName = opts.room;

            this.drawQ = new DrawQueue();
            //Initialize a path variable to hold the paths buffer as we recieve it from other clients
            this.paths = {};

            this.listen();
            this.render();

            //this.brush = new Brush((new ColorModel()).toRGB(), 2.0);
            this.style = {
                tool: TOOLS.BRUSH,
                globalAlpha: 1,
                globalCompositeOperation: "source-over",
                strokeStyle: (new ColorModel()).toRGB(),
                lineWidth: 10,
                lineCap: "round",
                lineJoin: "round"
            };

            // debounce a function for repling
            this.attachEvents();

            this.on("show", function () {
                DEBUG && console.log("drawing_client:show");
                self.$el.show();
            });

            this.on("hide", function () {
                DEBUG && console.log("drawing_client:hide");
                self.$el.hide();
            });
            this.layerBackground = this.$el.find('canvas.background')[0];

            //Background (where everything gets drawn ultimately)
            this.bctx = this.layerBackground.getContext('2d');

            /*this.ctx.lineWidth = 2;
            this.ctx.strokeStyle = 'black';*/
            this.timeCapsule = null;
        },

        kill: function () {
            var self = this;

            DEBUG && console.log("killing DrawingClientView", self.channelName);
        },

        getCoords: function (ev) {
            if (typeof ev.offsetX === "undefined") {
                var offset = $(ev.target).offset();
                return {
                    x: ev.clientX - offset.left,
                    y: ev.clientY - offset.top
                };
            } else {
                return {
                    x: ev.offsetX,
                    y: ev.offsetY
                };
            }
        },

        startPath: function (coords) {

            this.cursorDown = true;
            this.buffer = [];
            this.timer = new TimeCapsule();
            this.movePath(_.extend(coords,{
                beginPath: true
            }));
        },
        movePath: function (coords) {
            if (!this.cursorDown) { return; }
            
            var ctx = this.bctx;
            //Set up the coordinates
            coords.lapse = this.timer.getLapse();
            if (coords.beginPath){
                coords.style = _.clone(this.style);
            }
            // Push coords to current path.
            this.buffer.push(coords);
            //Stream the point out
            this.socket.emit("draw:line:" + this.channelName, {
                coord: coords
            });
            //Prepare the canvas
            var self = this, 
                buffer = this.buffer;
            //TODO: Global path (for history purposes)
            window.requestAnimationFrame(function(){
                ctx.save();
                _.extend(ctx,self.style);
                ctx.globalCompositeOperation = "source-over";
                //Setup Eraser (TODO: FIX)
                if (self.style.tool === TOOLS.ERASER) {
                    self.layerBackground.style.display = "none";
                    ctx.save();
                    ctx.globalAlpha = 1;
                    ctx.drawImage(self.layerBackground, 0, 0);
                    ctx.restore();
                    ctx.globalCompositeOperation = "destination-out";
                }
                //ctx.scale(this.zoom, this.zoom);
                self.catmull(buffer.slice(buffer.length - 4, buffer.length),ctx);
                if(coords.endPath){
                    if (self.style.tool == TOOLS.ERASER) {
                        self.layerBackground.style.display = "block";
                        self.bctx.clearRect(0, 0, innerWidth, innerHeight);
                    }
                }
                ctx.restore();
            });
        },
        stopPath: function (coords) {
            //Record what we just drew to the foreground and clean up
            this.movePath(_.extend(coords,{
                endPath: true
            }));

            this.cursorDown = false;
            /*if (dstEraser) {
                layer1.style.display = "block";
                ctx1.clearRect(0, 0, innerWidth, innerHeight);
            }*/
        },

        trash: function () {
            this.bctx.clearRect(0, 0, this.layerBackground.width, this.layerBackground.height);
            this.fctx.clearRect(0, 0, this.layerForeground.width, this.layerForeground.height);
            this.ctx.clearRect(0, 0, this.layerActive.width, this.layerActive.height);
        },

        attachEvents: function () {
            var self = this;

            this.samplePoints = _.throttle(this.movePath, 40);

            this.$el.on("mousedown", ".canvas-area", function (ev) {
                self.startPath(self.getCoords(ev));
            });
            this.$el.on("mouseup", ".canvas-area", function (ev) {
                self.stopPath(self.getCoords(ev));
            });
            this.$el.on("mousemove", ".canvas-area", function (ev) {
                if (!self.cursorDown) { return; }
                self.samplePoints(self.getCoords(ev));
            });


            this.$el.on("click", ".tool.trash", function () {
                DEBUG && console.log("emitting trash event");
                self.trash();
                self.socket.emit("trash:" + self.channelName, {});
            });

            this.$el.on("click", ".tool.eraser", function(){
                //TODO: Eraser code here
                self.style.tool = TOOLS.ERASER;
            });

            this.$el.on("click", ".swatch", function (ev) {
                self.style.strokeStyle = $(this).data("color");
            });

            this.$el.on("click", ".tool.pen", function () {
                
                $(this).find(".tool-options .swatch").each(function (index, ele) {
                    var randomColor = (new ColorModel()).toRGB();
                    $(ele).css("background", randomColor)
                        .data("color", randomColor);
                });

                $(this).find(".tool-options").toggleClass("active");
            });

            $(window).on("keydown", function (ev) {
                if (self.$el.is(":visible")) {
                    if (ev.keyCode === 221) { // } key
                        self.style.lineWidth += 0.25;
                    } else if (ev.keyCode === 219) { // { key
                        self.style.lineWidth -= 0.25;
                    }
                }
            });
        },

        showPenOptions: function () {

        },

        refresh: function () {

        },

        listen: function () {
            var self = this,
            socket = this.socket;

            this.socketEvents = {
                "draw:line": function (msg) {
                    /*var line = new BezierLine(msg.fromX, msg.fromY, self.ctx, msg.ctxState, msg.bezier);
                    self.drawQ.add(line);*/
                    //Draw to the foreground context
                    var ctx = self.bctx;
                    var path = self.paths[msg.cid] = (self.paths[msg.cid] || []);
                    if (msg.coord.beginPath){
                        path = self.paths[msg.cid] = [];
                    }
                    path.push(msg.coord);
                    window.requestAnimationFrame(function(){
                        ctx.save();
                        //Load the style
                        _.extend(ctx,path[0].style);
                        if (path[0].style.tool === TOOLS.ERASER) {
                            self.layerBackground.style.display = "none";
                            ctx.globalAlpha = 1;
                            ctx.drawImage(self.layerBackground, 0, 0);
                            ctx.globalCompositeOperation = "destination-out";
                        }
                        //ctx.scale(this.zoom, this.zoom);
                        self.catmull(path.slice(path.length - 4, path.length),ctx);
                        ctx.restore();
                        if (msg.coord.endPath){
                            if (path[0].style.tool == TOOLS.ERASER) {
                                self.layerBackground.style.display = "block";
                                self.bctx.clearRect(0, 0, innerWidth, innerHeight);
                            }
                        }
                    });
                },
                "trash": function () {
                    self.trash();
                }
            };
            _.each(this.socketEvents, function (value, key) {
                // listen to a subset of event
                socket.on(key + ":" + self.channelName, value);
            });

            // initialize the channel
            socket.emit("subscribe", {
                room: self.channelName
            });
            //On successful reconnect, attempt to rejoin the room
            socket.on("reconnect",function(){
                //Resend the subscribe event
                socket.emit("subscribe", {
                    room: self.channelName
                });
            });
        },

        render: function () {
            this.$el.html(this.template());
            this.$el.attr("data-channel", this.channelName);
        },

        //Catmull-Rom spline
        catmull: function (path,ctx,tens) {
            var tension = 1 - (tens || 0);
            var length = path.length - 3;
            path.splice(0, 0, path[0]);
            path.push(path[path.length - 1]);
            if (length <= 0) return;
            for (var n = 0; n < length; n ++) {
                var p1 = path[n];
                var p2 = path[n + 1];
                var p3 = path[n + 2];
                var p4 = path[n + 3];
                if (n === 0) {
                    ctx.beginPath();
                    ctx.moveTo(p2.x, p2.y);
                }
                ctx.bezierCurveTo(
                    p2.x + (tension * p3.x - tension * p1.x) / 6,
                    p2.y + (tension * p3.y - tension * p1.y) / 6,
                    p3.x + (tension * p2.x - tension * p4.x) / 6,
                    p3.y + (tension * p2.y - tension * p4.y) / 6,
                    p3.x, p3.y
                );
            }
            ctx.stroke();
        }

    });

    return DrawingClientView; // todo: return a different view for different top-level options
}