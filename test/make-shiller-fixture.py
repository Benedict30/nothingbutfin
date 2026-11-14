"""Writes the two small .xls files test/shiller.test.js reads. Needs xlwt (pip install xlwt).
Run: python test/make-shiller-fixture.py

shiller-fixture.xls is laid out like Robert Shiller's ie_data.xls (a "Data" sheet: month, price, dividend,
earnings, …) with made-up figures, except January 1871's, which lib/shiller.js checks. It starts in 1871 and
then jumps to 2016. shiller-shifted.xls is its first rows with the earnings one column to the right, as if the
layout had changed.
"""
import os
import xlwt

HERE = os.path.dirname(os.path.abspath(__file__))
HEAD = ["Date", "P", "D", "E", "CPI", "Fraction", "Rate GS10", "Price", "CAPE"]


def book(shift, years):
    wb = xlwt.Workbook()
    wb.add_sheet("Disclaimer").write(0, 0, "Made-up figures for a test.")
    sh = wb.add_sheet("Data")
    sh.write(1, 0, "Stock Market Data")
    for c, name in enumerate(HEAD):
        sh.write(7, c, name)
    months = [(1871, 1), (1871, 2)] + [(y, m) for y in years for m in range(1, 13) if (y, m) <= (2026, 10)]
    for i, (y, m) in enumerate(months):
        r = 8 + i
        old = y == 1871
        price = 4.44 if (y, m) == (1871, 1) else 4.5 if old else 2000 + i * 43  # whole numbers: packed integers
        earnings = 0.4 if old else round(100 + i * 1.5 + 0.1234567, 7)  # many decimals: full doubles
        sh.write(r, 0, y + m / 100)  # 2026.1 is October 2026, as in the real file
        sh.write(r, 1, price)
        sh.write(r, 2, 0.26)
        if (y, m) <= (2026, 6):  # the last four months have a price but no earnings yet
            sh.write(r, 3 + shift, earnings)
        sh.write(r, 5 + shift, 12.46406116)
        sh.write(r, 7 + shift, xlwt.Formula("B%d*2" % (r + 1)))
        sh.write(r, 8 + shift, "NA" if old else 30.5)
    sh.write(8 + len(months) + 1, 1, "Oct price is Oct 2nd close")
    return wb


book(0, range(2016, 2027)).save(os.path.join(HERE, "shiller-fixture.xls"))
book(1, []).save(os.path.join(HERE, "shiller-shifted.xls"))
print("written")
