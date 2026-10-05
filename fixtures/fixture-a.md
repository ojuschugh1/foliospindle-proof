# Harrowmere Ridge Loop: Trail Notes

A walking record kept over three seasons on a twelve kilometre loop above a lake town that exists only in these pages. The notes are written for anyone who wants to repeat the walk without a guide, so they favour plain landmarks over map references and record what changed between visits rather than what stayed the same.

## The route in brief

The loop starts at the boathouse on the north shore, climbs through beech woodland to the ridge, follows the ridge west for about four kilometres, and descends by the old quarry track back to the shore path. Walked clockwise it keeps the steepest climb for the shaded morning side; walked the other way it saves the views for the end.

- Distance: 12.4 km measured by wheel, 11.9 km by the sign at the boathouse
- Height gain: roughly 540 m, most of it in the first ninety minutes
- Surface: packed earth in the woods, bare rock on the ridge, loose gravel on the quarry track
- Water: one spring below the ridge, dry from late July in a warm year
- Shelter: a stone bothy at the western end of the ridge, door latched, no stove

### Timing

Allow five hours at an easy pace with a long stop at the bothy. The fastest time in these notes is three hours and forty minutes, set in October on dry rock with no stops. Add an hour after rain because the quarry gravel moves underfoot and the descent has to be taken slowly.

## Stage by stage

1. Boathouse to the first gate. Flat shore path, ten minutes. Ignore the first stile; the path goes through the gate beside it.
2. First gate to the beech bench. The climb proper. Zigzags are cut into the slope, and the shortcuts between them have eroded badly, so stay on the zigzags.
3. Beech bench to the spring. The gradient eases and the trees thin out. The spring is marked by a cairn and a trough fed by a pipe.
4. Spring to the ridge. Open ground, bilberry and heather, one short scramble over a rock step that is easier on the left.
5. Ridge walk. Follow the crest. In mist the path is faint; the fence posts on the south side are the safest guide.
6. Bothy to the quarry track. A stile behind the bothy leads to a grassy shoulder and then onto the track.
7. Quarry track to the shore. Long, loose, and dull, but fast. The lake appears again at the second bend.
8. Shore path to the boathouse. Flat, twenty minutes.

### Variations

- Short version: climb to the beech bench, cross to the quarry track by the forestry road, and return. About two hours.
- Long version: from the bothy continue west to the trig point and return the same way. Adds forty minutes and the best view on the hill.
- Wet weather version: shore path only, out and back to the inlet. Flat and sheltered.

## What changed between visits

Spring. The zigzags were greasy and the beech leaves from the previous autumn were still deep in the hollows. The spring ran hard. Two fallen trees lay across the path above the bench; both had been cut by June.

Summer. Dry, dusty, and busy at weekends. The spring was down to a trickle by the second week of August. Bilberries were ripe along the ridge in late July. The bothy book was full; a new one was in place by September.

Autumn. The best walking. Clear air, cold mornings, rock dry by ten. The quarry track was regravelled in October and stayed loose for a month afterwards. First frost on the ridge on the ninth of November.

Winter. Ice on the rock step from December. The ridge was in cloud more often than not. The shore path flooded twice after storms, and the boathouse car park closed for a week while the wall was repaired.

## Wildlife seen

- Red squirrels in the beech wood, most reliably in the hour after dawn.
- A pair of ravens that nest somewhere on the quarry face and patrol the ridge.
- Roe deer on the grassy shoulder below the bothy, usually at dusk.
- Grey wagtails at the spring whenever it is running.
- One adder, sunning itself on the rock step in May. It left before the walker did.

## What to carry

The loop is short enough that most of the usual advice is overkill, but three things have earned their place in the bag. A windproof layer, because the ridge is exposed for an hour and the wind off the lake is cold even in July. A litre of water, for the reasons given above. A head torch, because the quarry track is the slowest part and the one most likely to be walked in failing light. Food is optional; the bothy is a fine place for lunch, and the shop by the boathouse opens until six.

## Keeping the record

Each walk gets one entry: the date, the direction, the time at each stage boundary, the weather, and anything that differs from the last visit. The entries live in a plain text file, one line per stage, so they can be sorted and summed with ordinary tools. The columns are `date,direction,stage,arrived,note`, so a typical line reads `2025-10-04,clockwise,2,09:58,two trees cleared`, and a walk of eight stages takes eight lines. The header line is kept at the top of the file so that the columns stay obvious when the file is opened a year later.

A short awk program totals the stage times and prints the slowest stage for each walk, which is usually the climb and occasionally the quarry track after rain:

```sh
awk -F, 'NR > 1 {
  key = $1 "," $2
  split($4, t, ":")
  m = t[1] * 60 + t[2]
  if (key in last) {
    d = m - last[key]
    if (d > slow[key]) { slow[key] = d; stage[key] = $3 }
  }
  last[key] = m
}
END { for (k in slow) print k, "slowest stage", stage[k], slow[k] " min" }' walks.csv
```

The file is small enough to read by eye, which matters more than any script. Most of the value is in the notes column, where a single word such as "icy" or "flooded" explains a slow time better than the numbers do.

## Lessons

1. Start early in summer; the car park fills by nine.
2. Carry water from the boathouse after midsummer and do not rely on the spring.
3. Poles help on the quarry track and get in the way on the rock step.
4. The bothy is colder than the ridge when the wind is from the east.
5. A paper map still beats a phone on the ridge in cloud, because the phone cannot show the fence posts.
6. Write the entry the same evening. A week later the stages blur into one long climb.
