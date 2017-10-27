const {Location} = require('./location.js');
var m2 = require('mathjs');

////////////////////////////////////////////////////////////
//	System Conversion Functions
////////////////////////////////////////////////////////////
var d2r = x => x * Math.PI / 180;
var r2d = x => x * 180 / Math.PI;

//Surface distance across sphere.
var sdist = (lat1, lng1, lat2, lng2) =>
    Math.acos(Math.sin(lat1) * Math.sin(lat2) +
	      Math.cos(lat1) * Math.cos(lat2) * Math.cos(lng2 - lng1));
//Make a lat/lng pair into cartesian vector
var l2c = (lat, lng) => [
    Math.cos(lat) * Math.cos(lng),
    Math.cos(lat) * Math.sin(lng),
    Math.sin(lat)
];

//Returns [lat, lng, hyp] from [x, y, z] in standard coordinates
var c2l = c => {
    var ret = [
	0,
	Math.atan2(c[1], c[0]),
	Math.sqrt(Math.pow(c[0], 2) + Math.pow(c[1], 2))
    ];

    ret[0] = Math.atan2(ret[2], ret[1]);
    return ret;
};

////////////////////////////////////////////////////////////
//	Basis Converter Class
////////////////////////////////////////////////////////////
//Applies a rotation matrix to determine a point's re-mapped coordinates
//Returned coordinates are relative to the new point, with [1, 0, 0] being the origin
var BasisConverter = function(originLat, originLng, rotation){
    this.ta = -originLat;	// Matrix alpha
    this.tb = -originLng;	// Matrix beta
    this.tc = rotation;		// Matrix gamma

    //Create component matrices
    this.ma = m2.matrix([[1, 0, 0],
			   [0, Math.cos(this.ta), -Math.sin(this.ta)],
			   [0, Math.sin(this.ta), Math.cos(this.ta)]]);
    this.mb = m2.matrix([[0, Math.sin(this.tb), Math.cos(this.tb)],
			   [1, 0, 0],
			   [0, Math.cos(this.tb), -Math.sin(this.tb)]]);
    this.mc = m2.matrix([[0, Math.cos(this.ta), -Math.sin(this.ta)],
			   [0, Math.sin(this.ta), Math.cos(this.ta)],
			   [1, 0, 0]]);

    //Compute the aggregate transformation matrix
    this.matrix = m2.multiply(m2.multiply(this.ma, this.mb), this.mc);
    this.antiMatrix = m2.inv(this.matrix);

    //Convert a standard lat/lng pair to a transformed coordinate
    this.convert = function(lat, lng){
	//Convert to point and transform
	var p = l2c(lat, lng);
	p = m2.multiply(this.matrix, p);

	return p;
    }

    //Converts an x/y/z point in the altered basis to a standard lat/lng pair
    this.revert = function(point){
	var p = m2.multiply(this.antiMatrix, point);
	return c2l(p);
    }
}


////////////////////////////////////////////////////////////
//	PsGrid Class
////////////////////////////////////////////////////////////
//Param: points		An array of objects with a member 'location' of type Location
//Param: columns	Number of column to draw on this grid.
//Param: rows		Number of rows to draw on this grid
//Param: rotOffset	Rotational offset clockwise (in degrees);
var PsGrid = exports.PsGrid = function(columns, rows, points, rotOffset){
    //PsGridSpot Class
    //Takes center position and neighbouring gridspots
    var PsGridSpot = function(lat, lng, neighbours){
	this.lat = lat;
	this.lng = lng;
	this.neighbours = neighbours ? neighbours : new Array(4); // [right, up, left, down]
	this.points = [];	      // A list of all contained points
    }

    // Assign fields.
    this._columns = 2 * columns + 1; // have 'columns' columns on either side
    this._rows = 2 * rows + 1;	     // Same as columns
    this._centerCol = columns;
    this._centerRow = rows;
    this.skew = d2r(rotOffset);
    this.grid;			// Lookup grid
    this._points = [];

    ////////////////////////////////////////////////////////////
    //Methods
    ////////////////////////////////////////////////////////////
    //Find the centroid given the current points
    this._findCentroid = function(){
	var count = 0;
	var cartesianSum = [0, 0, 0];

	for(var point in this.points){
	    //Check that point satisfies data requirements.
	    //TODO: Geocode location if address only?
	    if(!('location' in point && point.location instanceof Location &&
		 point.location.hasCoords())) continue;

	    this._points.push(point); // Save
	    count++;

	    //Aggregate in centroid calculation
	    var lat = d2p(point.location.coords[0]);
	    var lng = d2p(point.location.coords[1]);
	    var c = l2c(lat, lng);
	    cartesianSum[0] += c[0];
	    cartesianSum[1] += c[1];
	    cartesianSum[2] += c[2];
	}

	//Cartesian center as mean of cartesian coordinates (unweighted)
	cartesianSum[0] /= count;
	cartesianSum[1] /= count;
	cartesianSum[2] /= count;

	//Centroid coordinate computed from cartesian center.
	c = c2l(cartesianSum);
	this.origin = {
	    lat: c[0],
	    lng: c[1],
	    hyp: c[2]
	};			// Origin coordinates in radians, hyp as fraction of geoid radius

	this.bConverter = new BasisConverter(c[0], c[1]);
    }

    //Setup the grid with (not quite) equally spaced points
    this._setupGrid = function(){
	this._findCentroid();

	var dy = 0, dz = 0;
	
	//Find maximum x/y deviation from center
	for(var p in points){
	    var c = this.bConverter.convert(points[p].location.coordinates[0], points[p].location.coordinates[1]);

	    if(Math.abs(c[1]) > dy) dy = Math.abs(c[1]);
	    if(Math.abs(c[2]) > dz) dz = Math.abs(c[2]);
	}

	//Optimal dX/dY est. at max deviation / count
	dy /= (this._columns - 1) / 2 ;
	dz /= (this._rows - 1) / 2;

	//Populate grid reference points
	this.grid = new Array(this._columns);
	for(var y = 0; y < this._columns; y++){
	    this.grid[y] = new Array(this._rows);	//Add cell for each row

	    for(var z = 0; z < this._rows; z++){
		//Revert grid point to standard coordinates
		var c = c2l(
		    this.bConverter.revert(
			[0,
			 dy * (y - this._centerCol),
			 dz * (z - this._centerRow)]));
		
		this.grid[y][z] = new PsGridSpot(c[0], c[1]);
	    }
	}

	//Connect grid points (y => vert, x => horiz)
	for(var x = 0; x < this._columns; x++){
	    for(var y = 0; y < this._rows; y++){
		var spot = this.grid[x][y];
		
		//Right
		if(x + 1 < this._columns){
		    spot.neighbours[0] = this.grid[x + 1][y];
		}

		//Up
		if(y + 1 < this._rows){
		    spot.neighbours[1] = this.grid[x][y + 1];
		}

		//Left
		if(x - 1 >= 0){
		    spot.neighbours[2] = this.grid[x - 1][y];
		}

		//Down
		if(y - 1 >= 0){
		    spot.neighbours[3] = this.grid[x][y - 1];
		}
	    }
	}
    }

    //Bin a single point
    this._bin = function(point){
	if(!(point in this.points)) this.points.push(point);
	if(!this.grid) this._setupGrid();

	var next = this.grid[this._centerCol][this._centerRow];
	var d = sdist(point.location.coordinates[0],
		      point.locatoin.coordinates[1],
		      next.lat, next.lng);
	var res;

	do{
	    res = next;
	    next = null;

	    for(var i = 0; i < 4; i++){
		var s2 = s.neighbours[i];
		if(s2 == null) continue;

		var d2 = sdist(point.location.coordinates[0],
			       point.locatoin.coordinates[1],
			       s2.lat, s2.lng);

		if(d2 < d){
		    next = s2;
		    d = d2;
		}
	    }
	}while(next);
	
	res.points.push(point);
    }
    
    //Resets the grid and bins all of the points
    this.reBinAll = function(){
	this._setupGrid();	
	
	for(var p in this.points){
	    this.bin(p);
	}
    };

    //Finally, bin all the data points (creates grid)
    this.reBinAll();
};
